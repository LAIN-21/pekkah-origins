// Imported first by index.ts, so it runs before any other module: stdout carries the MCP
// protocol, and anything else that prints (libraries included) goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
