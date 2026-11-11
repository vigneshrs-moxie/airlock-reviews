// The one place that knows where the local Airlock service is.
// WXT_AIRLOCK_PORT is read at build time; the end-to-end build sets it to the fake service's port.
const port: string = import.meta.env.WXT_AIRLOCK_PORT || '4611';

export const SERVICE_URL = `http://127.0.0.1:${port}`;
