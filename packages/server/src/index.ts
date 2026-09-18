import process from "node:process";
if (process.argv[2] === "chromium") await import("./chromium");
else await import("./dom");
process.exit(0);
