// Resolución de la salida del doblaje: el endpoint de render donde se escribe
// el audio para que aparezca como micrófono en Meet/Zoom/Teams.
//
// Prioridad: el dispositivo configurado → el driver propio de VOXORA Meet →
// VB-Cable. Si hay que caer a una alternativa se devuelve `warning` para que
// la UI lo explique; si no hay ninguna, error `virtual_mic_missing`.

/** Pares conocidos: dónde escribe la app → qué micrófono elegir en Meet. */
export const KNOWN_VIRTUAL_CABLES = Object.freeze([
  { render: 'VOXORA Meet Speaker', capture: 'VOXORA Meet Microphone', label: 'VOXORA Meet (driver propio)' },
  { render: 'CABLE Input', capture: 'CABLE Output', label: 'VB-Cable' },
]);

const norm = (value) => String(value ?? '').trim().toLowerCase();

/** Busca un endpoint por id exacto o por subcadena del nombre (sin mayúsculas). */
export function findEndpoint(endpoints, wanted) {
  const needle = norm(wanted);
  if (!needle) return null;
  return endpoints.find((ep) => ep.id === wanted)
    ?? endpoints.find((ep) => norm(ep.name) === needle)
    ?? endpoints.find((ep) => norm(ep.name).includes(needle))
    ?? null;
}

function routeError(message) { return Object.assign(new Error(message), { code: 'audio_route_invalid' }); }

function uniqueEndpoint(endpoints, wanted) {
  const byId = endpoints.find((ep) => ep.id === wanted);
  if (byId) return byId;
  const exact = endpoints.filter((ep) => norm(ep.name) === norm(wanted));
  const matches = exact.length ? exact : endpoints.filter((ep) => norm(ep.name).includes(norm(wanted)));
  if (matches.length !== 1) throw routeError(`No se puede identificar un único dispositivo «${wanted}». Actualiza los dispositivos y selecciona uno por su nombre completo.`);
  return matches[0];
}

/** Validate and pin actual endpoints, including the Windows default input. */
export function validateAudioRoutes({ settings, output, captures, renders }) {
  const input = settings.micDeviceId
    ? captures.find((ep) => ep.id === settings.micDeviceId)
    : captures.find((ep) => ep.default || ep.isDefault);
  if (!input) throw routeError('El micrófono de entrada no está disponible. Selecciona tu micrófono físico.');
  if (KNOWN_VIRTUAL_CABLES.some((c) => norm(input.name).includes(norm(c.capture)))) {
    throw routeError('La entrada es un micrófono virtual de doblaje. Selecciona tu micrófono físico para evitar que la voz vuelva a traducirse.');
  }
  const main = uniqueEndpoint(renders, output.deviceId || output.deviceName);
  let monitor = null;
  if (settings.monitorDevice) {
    monitor = uniqueEndpoint(renders, settings.monitorDevice);
    if (monitor.id === main.id) throw routeError('La escucha local y el doblaje usan la misma salida. Desactiva la escucha local o elige tus auriculares.');
    if (KNOWN_VIRTUAL_CABLES.some((c) => norm(monitor.name).includes(norm(c.render)))) {
      throw routeError('La escucha local debe salir por auriculares o altavoces, no por un cable virtual.');
    }
  }
  return { input, output: main, monitor };
}

/** Micrófono que el usuario debe elegir en Meet para un endpoint de render dado. */
export function captureNameFor(renderName) {
  const known = KNOWN_VIRTUAL_CABLES.find((c) => norm(renderName).includes(norm(c.render)));
  return known?.capture ?? null;
}

/**
 * Resuelve sin lanzar: describe qué se usaría con la lista actual de endpoints.
 * @param {Array<{id:string,name:string,isDefault?:boolean}>} endpoints
 * @param {string} configured  ajuste `virtualMicDevice`
 */
export function describeOutput(endpoints, configured) {
  const candidates = KNOWN_VIRTUAL_CABLES
    .map((c) => findEndpoint(endpoints, c.render))
    .filter(Boolean)
    .map((ep) => ep.name);
  const direct = findEndpoint(endpoints, configured);
  if (direct) {
    return { endpoint: direct, captureName: captureNameFor(direct.name), fallback: false, candidates };
  }
  for (const cable of KNOWN_VIRTUAL_CABLES) {
    const ep = findEndpoint(endpoints, cable.render);
    if (ep) return { endpoint: ep, captureName: cable.capture, fallback: true, candidates };
  }
  return { endpoint: null, captureName: null, fallback: false, candidates };
}

/**
 * Para arrancar sesión: devuelve `{ deviceId, deviceName, captureName, warning? }` o lanza.
 * @param {() => Promise<Array>} listRenderEndpoints
 */
export async function resolveOutputDevice(listRenderEndpoints, configured) {
  const endpoints = await listRenderEndpoints();
  const { endpoint, captureName, fallback } = describeOutput(endpoints, configured);
  if (!endpoint) {
    throw Object.assign(
      new Error('No hay micrófono virtual disponible. Instala el driver de VOXORA Meet o VB-Cable (vb-audio.com/Cable) y pulsa "Actualizar dispositivos".'),
      { code: 'virtual_mic_missing' },
    );
  }
  const result = { deviceId: endpoint.id, deviceName: endpoint.name, captureName };
  if (fallback) {
    result.warning = `No se encontró "${configured}". El doblaje sale por "${endpoint.name}"`
      + (captureName ? `; en Meet elige como micrófono "${captureName}".` : '.');
  }
  return result;
}
