import { unavailable } from "./unavailable";

// Happy DOM compiles its global-property script at import time and runs it only
// for VM-backed windows. GlobalWindow shares the isolate's own global realm.
export class Script {
	runInContext = unavailable("Script evaluation");
}
export default { Script, isContext: () => true, createContext: <Context>(context: Context) => context };
