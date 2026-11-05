use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const USAGE_WIDGET_LABEL: &str = "usage-widget";
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUsageSample {
    pub supported: bool,
    pub sampled_at: u64,
    pub cpu_percent: Option<f64>,
    pub cpu_window_ms: Option<u64>,
    pub cpu_error: Option<String>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_basis: Option<&'static str>,
    pub memory_error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn cpu_percent_from_ticks(previous: [u32; 4], current: [u32; 4]) -> Option<f64> {
    let delta = std::array::from_fn::<_, 4, _>(|index| current[index].wrapping_sub(previous[index]) as u64);
    let total = delta.iter().sum::<u64>();
    let idle = delta[2];
    (total > 0).then(|| ((total.saturating_sub(idle) as f64) / total as f64) * 100.0)
}

fn memory_used_bytes(active: u64, wired: u64, compressed: u64, page_size: u64) -> Option<u64> {
    active.checked_add(wired)?.checked_add(compressed)?.checked_mul(page_size)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{cpu_percent_from_ticks, memory_used_bytes, now_ms, SystemUsageSample};
    use std::ffi::{c_char, c_int, c_void};
    use std::mem::size_of;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    type Natural = u32;
    type Integer = i32;
    type MachPort = u32;
    type MachCount = u32;

    const HOST_CPU_LOAD_INFO: Integer = 3;
    const HOST_VM_INFO64: Integer = 4;
    const SUCCESS: Integer = 0;

    #[repr(C)]
    struct CpuLoadInfo {
        ticks: [Natural; 4],
    }

    #[repr(C, align(8))]
    struct VmStatistics64 {
        free_count: Natural,
        active_count: Natural,
        inactive_count: Natural,
        wire_count: Natural,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: Natural,
        speculative_count: Natural,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: Natural,
        throttled_count: Natural,
        external_page_count: Natural,
        internal_page_count: Natural,
        total_uncompressed_pages_in_compressor: u64,
    }

    #[link(name = "System")]
    unsafe extern "C" {
        fn mach_host_self() -> MachPort;
        fn host_statistics(
            host: MachPort,
            flavor: Integer,
            info: *mut Integer,
            count: *mut MachCount,
        ) -> Integer;
        fn host_statistics64(
            host: MachPort,
            flavor: Integer,
            info: *mut Integer,
            count: *mut MachCount,
        ) -> Integer;
        fn host_page_size(host: MachPort, page_size: *mut usize) -> Integer;
        fn sysctlbyname(
            name: *const c_char,
            old_value: *mut c_void,
            old_length: *mut usize,
            new_value: *mut c_void,
            new_length: usize,
        ) -> c_int;
    }

    struct CpuBaseline {
        ticks: [u32; 4],
        sampled_at: Instant,
    }

    static CPU_BASELINE: OnceLock<Mutex<Option<CpuBaseline>>> = OnceLock::new();
    static HOST: OnceLock<MachPort> = OnceLock::new();

    fn host() -> MachPort {
        *HOST.get_or_init(|| unsafe { mach_host_self() })
    }

    fn sample_cpu() -> (Option<f64>, Option<u64>, Option<String>) {
        let host = host();
        let mut load = CpuLoadInfo { ticks: [0; 4] };
        let mut count = (size_of::<CpuLoadInfo>() / size_of::<Integer>()) as MachCount;
        let result = unsafe {
            host_statistics(
                host,
                HOST_CPU_LOAD_INFO,
                (&mut load as *mut CpuLoadInfo).cast::<Integer>(),
                &mut count,
            )
        };
        if result != SUCCESS {
            return (None, None, Some(format!("Mach host_statistics failed ({result})")));
        }

        let now = Instant::now();
        let baseline = CPU_BASELINE.get_or_init(|| Mutex::new(None));
        let mut previous = match baseline.lock() {
            Ok(value) => value,
            Err(_) => return (None, None, Some("CPU sample lock is unavailable".into())),
        };
        let result = previous.as_ref().and_then(|sample| {
            let elapsed_ms = now.duration_since(sample.sampled_at).as_millis().min(u64::MAX as u128) as u64;
            cpu_percent_from_ticks(sample.ticks, load.ticks).map(|percent| (percent, elapsed_ms))
        });
        *previous = Some(CpuBaseline { ticks: load.ticks, sampled_at: now });
        match result {
            Some((percent, elapsed_ms)) => (Some(percent), Some(elapsed_ms), None),
            None => (None, None, None),
        }
    }

    fn system_memory() -> (Option<u64>, Option<u64>, Option<String>) {
        let host = host();
        let mut stats = VmStatistics64 {
            free_count: 0,
            active_count: 0,
            inactive_count: 0,
            wire_count: 0,
            zero_fill_count: 0,
            reactivations: 0,
            pageins: 0,
            pageouts: 0,
            faults: 0,
            cow_faults: 0,
            lookups: 0,
            hits: 0,
            purges: 0,
            purgeable_count: 0,
            speculative_count: 0,
            decompressions: 0,
            compressions: 0,
            swapins: 0,
            swapouts: 0,
            compressor_page_count: 0,
            throttled_count: 0,
            external_page_count: 0,
            internal_page_count: 0,
            total_uncompressed_pages_in_compressor: 0,
        };
        let mut count = (size_of::<VmStatistics64>() / size_of::<Integer>()) as MachCount;
        let result = unsafe {
            host_statistics64(
                host,
                HOST_VM_INFO64,
                (&mut stats as *mut VmStatistics64).cast::<Integer>(),
                &mut count,
            )
        };
        if result != SUCCESS {
            return (None, None, Some(format!("Mach host_statistics64 failed ({result})")));
        }

        let mut page_size = 0usize;
        let page_result = unsafe { host_page_size(host, &mut page_size) };
        if page_result != SUCCESS || page_size == 0 {
            return (None, None, Some(format!("Mach host_page_size failed ({page_result})")));
        }

        let mut total_bytes = 0u64;
        let mut total_length = size_of::<u64>();
        let name = b"hw.memsize\0";
        let sysctl_result = unsafe {
            sysctlbyname(
                name.as_ptr().cast(),
                (&mut total_bytes as *mut u64).cast::<c_void>(),
                &mut total_length,
                std::ptr::null_mut(),
                0,
            )
        };
        if sysctl_result != 0 || total_bytes == 0 {
            return (None, None, Some(format!("sysctl hw.memsize failed ({sysctl_result})")));
        }

        let Some(used_bytes) = memory_used_bytes(
            stats.active_count as u64,
            stats.wire_count as u64,
            stats.compressor_page_count as u64,
            page_size as u64,
        ) else {
            return (None, Some(total_bytes), Some("系统内存采样数值溢出".into()));
        };

        (Some(used_bytes), Some(total_bytes), None)
    }

    pub fn sample() -> SystemUsageSample {
        let (cpu_percent, cpu_window_ms, cpu_error) = sample_cpu();
        let (memory_used_bytes, memory_total_bytes, memory_error) = system_memory();
        SystemUsageSample {
            supported: true,
            sampled_at: now_ms(),
            cpu_percent,
            cpu_window_ms,
            cpu_error,
            memory_used_bytes,
            memory_total_bytes,
            memory_basis: Some("活跃页 + 已锁定页 + 压缩页"),
            memory_error,
        }
    }

    pub fn reset() {
        if let Some(baseline) = CPU_BASELINE.get() {
            if let Ok(mut value) = baseline.lock() {
                *value = None;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::SystemUsageSample;

    pub fn sample() -> SystemUsageSample {
        SystemUsageSample {
            supported: false,
            sampled_at: super::now_ms(),
            cpu_percent: None,
            cpu_window_ms: None,
            cpu_error: None,
            memory_used_bytes: None,
            memory_total_bytes: None,
            memory_basis: None,
            memory_error: None,
        }
    }

    pub fn reset() {}
}

fn guard() -> Result<(), String> {
    if crate::is_screenshot_demo() {
        Err("演示模式下不可操作".into())
    } else {
        Ok(())
    }
}

fn ensure_widget_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != USAGE_WIDGET_LABEL {
        return Err("只能从用量悬浮窗读取或重置系统采样".into());
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_usage_widget(app: AppHandle) -> Result<bool, String> {
    guard()?;
    if let Some(window) = app.get_webview_window(USAGE_WIDGET_LABEL) {
        macos::reset();
        window.close().map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let url = WebviewUrl::App("index.html?usage_widget=1".into());
    WebviewWindowBuilder::new(&app, USAGE_WIDGET_LABEL, url)
        .title("用量悬浮窗")
        .inner_size(368.0, 462.0)
        .min_inner_size(320.0, 340.0)
        .max_inner_size(560.0, 760.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build()
        .map_err(|error| format!("创建用量悬浮窗失败：{error}"))?;
    macos::reset();
    Ok(true)
}

#[tauri::command]
pub fn close_usage_widget(window: WebviewWindow) -> Result<(), String> {
    guard()?;
    if window.label() != USAGE_WIDGET_LABEL {
        return Err("只能从用量悬浮窗执行关闭操作".into());
    }
    macos::reset();
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn return_to_main(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    guard()?;
    if window.label() != USAGE_WIDGET_LABEL {
        return Err("只能从用量悬浮窗返回主界面".into());
    }
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
    }
    macos::reset();
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_usage_widget_system_metrics(window: WebviewWindow) -> Result<SystemUsageSample, String> {
    guard()?;
    ensure_widget_window(&window)?;
    Ok(macos::sample())
}

#[tauri::command]
pub fn reset_usage_widget_system_metrics(window: WebviewWindow) -> Result<(), String> {
    guard()?;
    ensure_widget_window(&window)?;
    macos::reset();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cpu_percent_from_ticks, memory_used_bytes};

    #[test]
    fn cpu_percent_uses_busy_tick_delta_across_all_cores() {
        let value = cpu_percent_from_ticks([100, 20, 60, 10], [150, 30, 80, 20]).unwrap();
        assert!((value - 77.777_777_777_8).abs() < 0.001);
    }

    #[test]
    fn cpu_percent_needs_a_nonempty_sampling_window() {
        assert_eq!(cpu_percent_from_ticks([1, 2, 3, 4], [1, 2, 3, 4]), None);
    }

    #[test]
    fn memory_uses_active_wired_and_compressed_pages_with_physical_total_elsewhere() {
        assert_eq!(memory_used_bytes(10, 4, 2, 4096), Some(65_536));
        assert_eq!(memory_used_bytes(u64::MAX, 1, 0, 4096), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_read_only_host_sampling_returns_bounded_system_metrics() {
        super::macos::reset();
        let initial = super::macos::sample();
        assert!(initial.supported);
        let total = initial.memory_total_bytes.expect("physical memory from hw.memsize");
        assert!(total > 0);
        let used = initial.memory_used_bytes.expect("active, wired, and compressed VM pages");
        assert!(used > 0 && used <= total);

        std::thread::sleep(std::time::Duration::from_millis(250));
        let next = super::macos::sample();
        let cpu = next.cpu_percent.expect("CPU tick delta after two samples");
        assert!((0.0..=100.0).contains(&cpu));
        assert!(next.cpu_window_ms.unwrap_or_default() > 0);
        let next_total = next.memory_total_bytes.expect("physical memory from hw.memsize");
        let next_used = next.memory_used_bytes.expect("VM memory sample");
        assert!(next_used > 0 && next_used <= next_total);
        assert_eq!(next_total, total);
        super::macos::reset();
    }
}
