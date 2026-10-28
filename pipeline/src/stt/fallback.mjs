// FallbackStt: encadena clientes de STT. Si el proveedor principal falla en un
// turno (caída, 429/5xx tras sus propios reintentos, key inválida), el mismo
// turno se reintenta con el siguiente proveedor configurado en vez de perderse.
// La cancelación (AbortError) nunca dispara el respaldo.
//
// Expone la misma superficie que un cliente de STT (provider, clientKind,
// model, temperature, setModel, setTemperature, close) delegando en el
// principal, así que el pipeline y `currentSettings()` no notan la envoltura.

const isAbort = (error, signal) => signal?.aborted || error?.name === "AbortError";

export class FallbackStt {
  #primary;
  #fallbacks;
  #onFallback;

  /**
   * @param {object} primary  cliente principal (transcribeTurn obligatorio)
   * @param {object[]} fallbacks  clientes de respaldo, en orden
   * @param {{ onFallback?: (info: { from: string, to: string, error: Error }) => void }} [opts]
   */
  constructor(primary, fallbacks = [], { onFallback } = {}) {
    if (!primary?.transcribeTurn) throw new TypeError("FallbackStt: `primary.transcribeTurn` obligatorio");
    this.#primary = primary;
    this.#fallbacks = fallbacks.filter((c) => c?.transcribeTurn);
    this.#onFallback = onFallback;
  }

  get provider() { return this.#primary.provider; }
  get clientKind() { return this.#primary.clientKind ?? this.#primary.provider; }
  get model() { return this.#primary.model; }
  get temperature() { return this.#primary.temperature; }
  get fallbackProviders() { return this.#fallbacks.map((c) => c.provider); }

  setModel(model) { this.#primary.setModel?.(model); }
  setTemperature(value) { this.#primary.setTemperature?.(value); }

  async transcribeTurn(args) {
    let firstError;
    let failed = this.#primary;
    for (const client of [this.#primary, ...this.#fallbacks]) {
      try {
        const result = await client.transcribeTurn(args);
        if (client !== this.#primary) {
          this.#onFallback?.({ from: failed.provider ?? "stt", to: client.provider ?? "stt", error: firstError });
          return { ...result, fallbackFrom: this.#primary.provider ?? null, provider: client.provider ?? result?.provider };
        }
        return result;
      } catch (error) {
        if (isAbort(error, args?.signal)) throw error;
        firstError ??= error;
        failed = client;
      }
    }
    throw firstError;
  }

  async close() {
    await Promise.allSettled([this.#primary, ...this.#fallbacks].map((c) => c.close?.()));
  }
}
