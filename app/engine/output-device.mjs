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
    ?? endpoints.find((ep) => norm(ep.name).includes(needle))
    ?? null;
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
