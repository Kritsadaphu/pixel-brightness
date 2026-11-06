// Optional hosted binding. The local Windows control server does not use D1.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
  }
}
