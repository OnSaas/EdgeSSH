import { api, hostCredentials, type CloudHost } from './cloud-api';
import './forward-page.css';

/** 转发持有独立 SSH 连接，不借用终端，防止预览页获得命令输入能力。 */
export class ForwardPage {
  readonly root = document.createElement('main');
  private hosts: CloudHost[] = [];
  private socket?: WebSocket;
  private sessionId?: string;
  private generation = 0;
  private busy = false;
  private ready = false;
  private popup: Window | null = null;
  private deadline?: ReturnType<typeof setTimeout>;
  private readonly select: HTMLSelectElement;
  private readonly port: HTMLInputElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  private readonly keyDialog: HTMLDialogElement;
  private pendingKey?: { socket: WebSocket; fingerprint: string };

  constructor() {
    this.root.className = 'forward-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="home-section-heading"><div><p class="home-eyebrow">PRIVATE WEB PREVIEW</p>
        <h1 tabindex="-1">端口转发</h1><p>通过 SSH，打开只监听在服务器本机的网站。</p></div>
        <span class="forward-badge">独立站点隔离</span></header>
      <section class="forward-card" aria-label="端口转发设置">
        <form class="forward-form">
          <label>目标主机<select name="host" required aria-describedby="forward-host-hint"><option value="">请选择主机</option></select></label>
          <label>网站端口<input name="port" type="number" min="1" max="65535" value="8080" required inputmode="numeric"></label>
          <button class="home-button primary" type="submit">连接并打开网站 ↗</button>
          <button class="home-button" type="button" data-stop disabled>停止转发</button>
        </form>
        <p id="forward-host-hint" class="forward-hint">访问目标固定为所选服务器的 <code>http://127.0.0.1:端口</code>，不是你电脑的本机端口。</p>
        <div class="forward-status"><span data-status role="status" aria-live="polite">未连接 · 请选择主机和网站端口</span>
          <button class="home-button" type="button" data-open hidden>重新打开预览 ↗</button></div>
        <a data-preview-link target="_blank" rel="noopener noreferrer" hidden>弹窗被拦截？点击打开隔离预览 ↗</a>
      </section>
      <section class="forward-explanation" aria-label="隔离与使用说明">
        <h2>让网站留在另一扇窗里</h2>
        <p>远端网站可能包含不可信脚本。预览在独立 Worker、独立站点打开，不共享 EdgeSSH 登录 Cookie，也不提供主机管理或终端接口。</p>
        <ol><li>选择云端主机，输入网站的 HTTP 端口。</li><li>核对 SSH 主机指纹，连接后自动打开预览。</li><li>用完点击停止；离开此页面、刷新或断线后，转发立即失效。</li></ol>
        <p class="forward-hint">支持常见资源、表单、网站 Cookie、HTTP 登录和重定向。单次授权最长 1 小时，上传最多 16 MiB。首版不支持 HTTPS 上游、WebSocket、Service Worker，以及脚本内写死的 localhost 地址。同一预览域名一次只使用一个网站，请先关闭旧预览窗口再切换。</p>
      </section>
      <dialog class="host-dialog" aria-labelledby="forward-key-heading">
        <h2 id="forward-key-heading">核对 SSH 主机指纹</h2>
        <p data-key-warning></p><p data-key-target></p><pre data-key-fingerprint></pre>
        <p class="forward-hint">请通过可信渠道核对。接受只用于本次连接，不会自动覆盖已保存指纹。</p>
        <div class="dialog-actions"><button class="home-button" type="button" data-key-reject>取消连接</button>
          <button class="home-button primary" type="button" data-key-accept>信任并连接</button></div>
      </dialog>`;
    this.select = this.get('select');
    this.port = this.get('input');
    this.startButton = this.get('[type="submit"]');
    this.stopButton = this.get('[data-stop]');
    this.openButton = this.get('[data-open]');
    this.keyDialog = this.get('dialog');
    this.get('[data-key-accept]').addEventListener('click', () => {
      const pending = this.pendingKey;
      if (pending?.socket.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify({ type: 'host_key_decision', fingerprint: pending.fingerprint, accept: true }));
      }
      this.pendingKey = undefined; this.keyDialog.close();
    });
    this.get('[data-key-reject]').addEventListener('click', () => this.stop('已取消：未信任主机指纹。'));
    this.keyDialog.addEventListener('cancel', (event) => { event.preventDefault(); this.stop('已取消：未信任主机指纹。'); });
    this.get('form').addEventListener('submit', (event) => { event.preventDefault(); void this.start(); });
    this.stopButton.addEventListener('click', () => this.stop());
    this.openButton.addEventListener('click', () => {
      this.reservePopup();
      void this.launch(this.generation);
    });
    window.addEventListener('pagehide', () => this.stop());
    window.addEventListener('auth-required', () => this.stop());
  }

  private get<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private message(text: string): void { this.get('[data-status]').textContent = text; }

  setHosts(hosts: CloudHost[]): void {
    this.hosts = hosts;
    const selected = this.select.value;
    this.select.replaceChildren(new Option(hosts.length ? '请选择主机' : '暂无主机，请先在总览添加', ''));
    for (const host of hosts) this.select.add(new Option(`${host.name} · ${host.username}@${host.host}`, host.id));
    this.select.value = hosts.some((host) => host.id === selected) ? selected : '';
    this.render();
  }

  show(): void { this.root.hidden = false; this.get('h1').focus(); }
  hide(): void {
    if (this.root.hidden) return;
    this.stop();
    this.root.hidden = true;
  }

  private render(): void {
    this.select.disabled = this.busy || this.ready;
    this.port.disabled = this.busy || this.ready;
    this.startButton.disabled = this.busy || this.ready || !this.hosts.length;
    this.startButton.textContent = this.busy ? '正在连接…' : '连接并打开网站 ↗';
    this.stopButton.disabled = !this.busy && !this.ready;
    this.openButton.hidden = !this.ready;
    this.openButton.disabled = this.busy;
  }

  private reservePopup(): void {
    // 同步占用用户手势；一开始就去掉 opener，不让远端页面访问主站窗口。
    this.popup = window.open('about:blank', '_blank');
    if (this.popup) {
      this.popup.opener = null;
      this.popup.document.title = 'EdgeSSH · 正在连接';
      this.popup.document.body.textContent = '正在建立 SSH 转发。请回到 EdgeSSH 核对首次连接的主机指纹。';
    }
  }

  private async start(): Promise<void> {
    if (this.busy || this.ready) return;
    const host = this.hosts.find((item) => item.id === this.select.value);
    if (!host) { this.message('请先选择一台已保存的主机。'); return; }
    const port = Number(this.port.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const generation = ++this.generation;
    this.reservePopup();
    this.busy = true; this.render(); this.message('正在获取连接授权…');
    this.deadline = setTimeout(() => this.stop('连接超时，请检查主机后重试。'), 60_000);
    try {
      const credentials = await hostCredentials(host.id);
      if (generation !== this.generation) return;
      const ticket = await api<{ ticket: string; sessionId: string }>('/api/session', 'POST', {});
      if (generation !== this.generation) return;
      this.sessionId = ticket.sessionId;
      const url = new URL('/api/ssh', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket.ticket); url.searchParams.set('session', ticket.sessionId);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        socket.send(JSON.stringify({
          type: 'connect', mode: 'forward', host: host.host, port: host.port,
          username: host.username, authMethod: host.authMethod, ...credentials,
          ...(host.fingerprint ? { expectedFingerprint: host.fingerprint } : {}),
        }));
        credentials.password = undefined; credentials.privateKey = undefined;
        this.message('正在连接 SSH，首次连接请核对主机指纹…');
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generation || typeof event.data !== 'string') return;
        const message = JSON.parse(event.data) as { type: string; trusted?: boolean; fingerprint?: string; expectedFingerprint?: string };
        if (message.type === 'host_key' && !message.trusted) {
          if (!message.fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(message.fingerprint)) {
            this.stop('收到无效的主机指纹，请重新连接。'); return;
          }
          // 新窗口可能已取得焦点，原生 confirm 会被浏览器抑制；站内对话框不会默默拒绝首次连接。
          this.pendingKey = { socket, fingerprint: message.fingerprint };
          this.get('[data-key-warning]').textContent = message.expectedFingerprint
            ? `警告：主机指纹已变化！原指纹：${message.expectedFingerprint}` : '首次连接，请通过可信渠道核对主机指纹。';
          this.get('[data-key-target]').textContent = `${host.name} (${host.host})`;
          this.get('[data-key-fingerprint]').textContent = message.fingerprint;
          this.keyDialog.showModal();
        } else if (message.type === 'ready') {
          clearTimeout(this.deadline);
          void this.launch(generation);
        } else if (message.type === 'error') this.stop('SSH 连接失败，请检查凭据、指纹和服务器状态。');
      });
      socket.addEventListener('close', () => { if (generation === this.generation) this.stop('SSH 已断开，预览授权已失效。'); });
      socket.addEventListener('error', () => { if (generation === this.generation) this.stop('SSH 连接失败，请重新连接。'); });
    } catch (error) { if (generation === this.generation) this.stop(error instanceof Error ? error.message : '连接失败。'); }
  }

  private async launch(generation: number): Promise<void> {
    if (!this.sessionId) return;
    this.busy = true; this.render();
    this.get('[data-preview-link]').hidden = true;
    try {
      const { url, expiresAt } = await api<{ url: string; expiresAt: number }>(
        `/api/forwarding?session=${this.sessionId}`, 'POST', { port: Number(this.port.value) });
      if (generation !== this.generation) return;
      this.ready = true;
      const link = this.get<HTMLAnchorElement>('[data-preview-link]');
      link.href = url;
      if (this.popup && !this.popup.closed) this.popup.location.replace(url);
      else link.hidden = false;
      this.popup = null;
      this.message(`已转发 127.0.0.1:${this.port.value} · 授权至 ${new Date(expiresAt).toLocaleTimeString()} · 请保持本页打开`);
    } catch (error) {
      if (generation === this.generation) this.stop(error instanceof Error ? error.message : '创建转发失败。');
    } finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }

  stop(message = '已停止转发，预览授权已失效。'): void {
    this.generation++;
    clearTimeout(this.deadline);
    this.pendingKey = undefined; this.keyDialog.close();
    this.popup?.close(); this.popup = null;
    this.socket?.close(); this.socket = undefined;
    // 主 WebSocket 关闭就是撤销操作；无需依赖卸载页面时不可靠的异步 fetch。
    this.sessionId = undefined; this.busy = false; this.ready = false;
    this.get('[data-preview-link]').hidden = true;
    this.get<HTMLAnchorElement>('[data-preview-link]').removeAttribute('href');
    this.message(message); this.render();
  }
}
