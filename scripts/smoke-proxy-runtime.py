#!/usr/bin/env python3
"""Verify the real engine/plugin in an empty temporary account store. No inference."""
import json, os, secrets, shutil, signal, socket, subprocess, tempfile, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
root = Path(__file__).resolve().parents[1]
default_engine = root/'runtime/cli-proxy-api-wb'
if not default_engine.exists():
    default_engine = root/'runtime/cli-proxy-api'
with tempfile.TemporaryDirectory(prefix='wb-proxy-smoke-') as folder:
    folder = Path(folder)
    (folder/'auths').mkdir(); (folder/'plugins').mkdir()
    use_plugin = os.environ.get('WB_SKIP_PLUGIN') != '1'
    if use_plugin: shutil.copy2(os.environ.get('WB_PLUGIN_BINARY',str(root/'runtime/workbuddy.dylib')), folder/'plugins/workbuddy.dylib')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port=sock.getsockname()[1]
    key, management = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    config = f'''host: 127.0.0.1
port: {port}
auth-dir: {json.dumps(str(folder/'auths'))}
api-keys: [{json.dumps(key)}]
remote-management:
  allow-remote: false
  secret-key: {json.dumps(management)}
  disable-control-panel: true
logging-to-file: false
request-log: false
plugins:
  enabled: true
  dir: {json.dumps(str(folder/'plugins'))}
  configs:
    workbuddy:
      enabled: true
      checkin_auto: false
      lifecycle_auto: false
      daily_bonus: false
      token_keepalive: false
      mm_live_reload: false
'''
    conf=folder/'config.yaml';conf.write_text(config);conf.chmod(0o600)
    client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(path, token=None):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers={'Authorization':f'Bearer {token}'} if token else {})
        try:
            with client.open(req, timeout=3) as res:return res.status, json.load(res)
        except urllib.error.HTTPError as e:return e.code,None
    with (folder/'engine.log').open('wb') as log:
        proc=subprocess.Popen([os.environ.get('WB_ENGINE_BINARY',str(default_engine)),'--config',str(conf),'--local-model'],cwd=folder,env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TZ':'Asia/Shanghai'},stdout=log,stderr=log)
        try:
            for _ in range(60):
                if proc.poll() is not None: raise RuntimeError('Engine exited before readiness')
                try:
                    status,body=get('/v1/models',key)
                    if status==200:break
                except (OSError,urllib.error.URLError):pass
                time.sleep(0.5)
            else:
                proc.send_signal(signal.SIGQUIT)
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:pass
                raise RuntimeError('Engine readiness timed out')
            assert get('/v1/models')[0]==401,'Unauthenticated request was not rejected'
            assert get('/v1/models','wrong')[0]==401,'Incorrect key was not rejected'
            assert isinstance(body.get('data'),list),'Invalid OpenAI model list'
            status,plugins=get('/v0/management/plugins',management)
            assert status==200,'Plugin diagnostics unavailable'
            # Safe here: this temporary engine has no account credentials.
            print('Plugin diagnostics:',json.dumps([
                {k:p.get(k) for k in ('id','registered','effective_enabled')}
                for p in plugins.get('plugins',[])],ensure_ascii=False))
            if use_plugin: assert any(p.get('id')=='workbuddy' and p.get('registered') and p.get('effective_enabled') for p in plugins.get('plugins',[])), 'WorkBuddy plugin not active'
            if use_plugin:
                # Calls into the Go plugin and back into the host's empty auth store.
                # This exercises both C ABI directions, including returned-buffer frees.
                def probe(_):
                    status, result = get('/v0/management/plugins/workbuddy/accounts',management)
                    assert status == 200 and isinstance(result,dict), 'Plugin callback failed'
                with ThreadPoolExecutor(max_workers=8) as pool:
                    list(pool.map(probe,range(80)))
                assert proc.poll() is None,'Engine crashed during concurrent plugin calls'
                print('PASS: 80 plugin account reads with 8 concurrent workers (empty store).')
            print('PASS: engine readiness, API authentication, model endpoint; plugin test=' + str(use_plugin) + '; no accounts or inference.')
        except Exception:
            log.flush()
            text=(folder/'engine.log').read_text(errors='replace').replace(key,'[client key]').replace(management,'[management key]')
            print('Empty-store engine diagnostics:',text[:6500])
            raise
        finally:
            proc.terminate()
            try:
                code=proc.wait(timeout=10)
                print(f'Engine stopped within 10 seconds (exit={code}).')
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()
                raise RuntimeError('Engine did not stop within 10 seconds')
