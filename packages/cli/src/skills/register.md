Register your upend stack for a <name>.upend.site subdomain.

## How it works

1. You authenticate with upend.site
2. Submit your stack name and server IP
3. We create a DNS record pointing <name>.upend.site → your IP
4. Caddy on your server handles TLS automatically

## Register

```bash
bunx upend register
```

This will:
1. Open upend.site/register in your browser
2. You log in (GitHub OAuth)
3. You get a registration token
4. Paste the token back into the CLI
5. The CLI submits your stack name + IP to the upend.site API
6. DNS record is created within seconds

## Manual registration

If the CLI flow doesn't work, go to https://upend.site/register and:
1. Log in
2. Enter your stack name (e.g. "beta")
3. Enter your server IP (from `bunx upend status` or AWS console)
4. Click register

## After registration

Your stack will be live at `https://<name>.upend.site` within a few minutes.

Make sure:
- Caddy is running on port 80 (for ACME/TLS) and 443
- Your security group allows inbound 80 and 443
- The Caddyfile uses your domain name (upend deploy handles this)

## Register JWKS with Neon

Once your domain is live, register the JWKS URL so Neon's Data API can validate your JWTs:

```bash
bunx upend setup:jwks
```

This tells Neon to fetch your public keys from `https://<name>.upend.site/.well-known/jwks.json`.
