// Remembers which session this browser was following, so a reload goes back to it.
// Shared by the VR page and the flat web app (same browser storage, same session).
const SESSION_KEY = 'vr.agent.session'; // the SDK's id of the session we were following
const SERVICE_KEY = 'vr.agent.svc'; // the session service's own handle for it

export const sessionStore = {
  read() { try { return { svc: localStorage.getItem(SERVICE_KEY), sdk: localStorage.getItem(SESSION_KEY) }; } catch { return {}; } },
  write({ svc, sdk }) {
    try {
      svc ? localStorage.setItem(SERVICE_KEY, svc) : localStorage.removeItem(SERVICE_KEY);
      sdk ? localStorage.setItem(SESSION_KEY, sdk) : localStorage.removeItem(SESSION_KEY);
    } catch { /* optional */ }
  },
  clear() { this.write({}); },
};
