# Security Policy

## Reporting a vulnerability

Email **jnew00@gmail.com**. Please don't open a public issue for security problems.

Include what you found, where (file/endpoint), and reproduction steps. You'll get a response within a few days.

## Scope

Most valuable reports:

- Anything that could leak or exfiltrate a user's session token (the proxy in `app/api/proxy/route.ts` is the trust boundary)
- Proxy allowlist bypasses (reaching non-allowlisted endpoints or hosts)
- Injection via game API responses rendered in the UI

Out of scope: bugs in Gigaverse itself (report those to the Gigaverse team — responsibly, per their fair play rules).
