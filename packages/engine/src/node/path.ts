const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
export default { sep: "/", join, resolve: join };
