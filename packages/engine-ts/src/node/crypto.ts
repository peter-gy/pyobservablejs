import { unavailable } from "./unavailable";

export const webcrypto = globalThis.crypto;
export default { webcrypto, randomUUID: () => globalThis.crypto.randomUUID(), createHash: unavailable("Hashing") };
