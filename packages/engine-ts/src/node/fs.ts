import { unavailable } from "./unavailable";

const read = unavailable("File system access");
export default {
	existsSync: () => false,
	readFileSync: read,
	statSync: read,
	promises: { readFile: read, writeFile: read, mkdir: read, readdir: read, stat: read, rm: read },
};
