// ventura-client.js
// Drop-in frontend SDK for the Ventura platform
// Handles auth, API calls, and real-time WebSocket events

const API_BASE = 'http://localhost:3001/api';
const WS_URL   = 'ws://localhost:3001/ws';

class VenturaClient {
  constructor() {
    this.accessToken  = localStorage.getItem('ventura_access_token');
    this.refreshToken = localStorage.getItem('ventura_refresh_token');
    this.ws           = null;
    this.wsReady      = false;
    this.eventHandlers = {};
    this.reconnectAttempts = 0;
    this.subscribedBusinesses = new Set();
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  async register(email, name, password) {
    const data = await this._post('/auth/register', { email, name, password });
    this._storeTokens(data);
    return data.user;
  }

  async login(email, password) {
    const data = await this._post('/auth/login', { email, password });
    this._storeTokens(data);
    return data.user;
  }

  async me() {
    return (await this._get('/auth/me')).user;
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    localStorage.removeItem('ventura_access_token');
    localStorage.removeItem('ventura_refresh_token');
    this.ws?.close();
  }

  get isLoggedIn() {
    return !!this.accessToken;
  }

  // ─── Businesses ────────────────────────────────────────────────────────────

  async getBusinesses() {
    return (await this._get('/businesses')).businesses;
  }

  async getBusiness(id) {
    return (await this._get(`/businesses/${id}`)).business;
  }

  async createBusiness(data) {
    return this._post('/businesses', data);
  }

  async updateBusiness(id, data) {
    return this._patch(`/businesses/${id}`, data);
  }

  // ─── Agent ─────────────────────────────────────────────────────────────────

  async runAgent(businessId) {
    return this._post(`/businesses/${businessId}/run`, {});
  }

  async getCycles(businessId) {
    return (await this._get(`/businesses/${businessId}/cycles`)).cycles;
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  async getTasks(businessId) {
    return (await this._get(`/businesses/${businessId}/tasks`)).tasks;
  }

  async addTask(businessId, { title, description, department, priority }) {
    return this._post(`/businesses/${businessId}/tasks`, { title, description, department, priority });
  }

  // ─── Activity ──────────────────────────────────────────────────────────────

  async getActivity(businessId, limit = 50) {
    return (await this._get(`/businesses/${businessId}/activity?limit=${limit}`)).activity;
  }

  // ─── Metrics ───────────────────────────────────────────────────────────────

  async getMetrics(businessId) {
    return this._get(`/businesses/${businessId}/metrics`);
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  async getMessages(businessId) {
    return (await this._get(`/businesses/${businessId}/messages`)).messages;
  }

  async sendMessage(businessId, content) {
    return (await this._post(`/businesses/${businessId}/messages`, { content })).message;
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  connectWebSocket() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.wsReady = true;
      this.reconnectAttempts = 0;

      // Authenticate immediately
      if (this.accessToken) {
        this._wsSend({ type: 'auth', token: this.accessToken });
      }

      // Re-subscribe to any active businesses
      for (const bizId of this.subscribedBusinesses) {
        this._wsSend({ type: 'subscribe', businessId: bizId });
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this._emit(msg.event, msg);
      } catch {}
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this.wsReady = false;
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  subscribeToBusiness(businessId) {
    this.subscribedBusinesses.add(businessId);
    if (this.wsReady) {
      this._wsSend({ type: 'subscribe', businessId });
    }
  }

  // ─── Event system ──────────────────────────────────────────────────────────

  on(event, handler) {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = [];
    this.eventHandlers[event].push(handler);
    return () => this.off(event, handler); // returns unsubscribe fn
  }

  off(event, handler) {
    this.eventHandlers[event] = (this.eventHandlers[event] || []).filter(h => h !== handler);
  }

  _emit(event, data) {
    (this.eventHandlers[event] || []).forEach(h => h(data));
    (this.eventHandlers['*'] || []).forEach(h => h(event, data));
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  async _get(path) {
    return this._request('GET', path);
  }

  async _post(path, body) {
    return this._request('POST', path, body);
  }

  async _patch(path, body) {
    return this._request('PATCH', path, body);
  }

  async _request(method, path, body = undefined) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;

    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    // Auto-refresh on 401
    if (res.status === 401 && this.refreshToken) {
      const refreshed = await this._refreshTokens();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryRes = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (!retryRes.ok) throw new Error((await retryRes.json()).error || retryRes.statusText);
        return retryRes.json();
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  async _refreshTokens() {
    try {
      const res = await fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken })
      });
      if (!res.ok) { this.logout(); return false; }
      const data = await res.json();
      this._storeTokens(data);
      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  _storeTokens({ accessToken, refreshToken }) {
    this.accessToken  = accessToken;
    this.refreshToken = refreshToken;
    localStorage.setItem('ventura_access_token', accessToken);
    localStorage.setItem('ventura_refresh_token', refreshToken);
  }

  _wsSend(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts > 5) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    console.log(`[WS] Reconnecting in ${delay}ms...`);
    setTimeout(() => this.connectWebSocket(), delay);
  }
}

// Export singleton
const ventura = new VenturaClient();
export default ventura;
