# Cloudflare and Traefik

The supported production path is browser → Cloudflare → existing Traefik HTTPS
entrypoint → app port 3000 on the proxy network. Traefik terminates origin TLS;
the last hop is HTTP on the controlled Docker network. The app and PostgreSQL
remain on the Docker host. No collector container mounts the Docker socket or
requires a Cloudflare API token.

## Routing labels and TLS

`compose.traefik.yaml` holds the configurable Docker labels: hostname rule,
entrypoint, TLS, Docker network, router service and application port. Set
`COLLECTOR_HOSTNAME`, `TRAEFIK_NETWORK` and optionally `TRAEFIK_ENTRYPOINT` to
substitute those values, or maintain an operator override with your labels.
If editing a Host rule directly, set the app's `PUBLIC_ORIGIN` to that same
`https://hostname` too: the app cannot discover Docker labels without socket
access. The bundled Compose files derive it from `COLLECTOR_HOSTNAME`.

Only the app joins the existing external proxy network. PostgreSQL is confined
to the internal backend network and has no host port. Bootstrap has networking
disabled. The production files publish no app port either; omit
`compose.local.yaml` in production.

In Cloudflare, create a proxied (orange-cloud) A/AAAA or CNAME record for the
hostname, enable **Always Use HTTPS** at the edge, and choose **Full (strict)**. Traefik must
serve an unexpired certificate valid for that hostname, from a public CA or
Cloudflare Origin CA. Manage it in the existing Traefik configuration. If using
an ACME resolver, add the appropriate router `tls.certresolver` label in your
operator override. Keep its infrastructure credentials outside the collector.
[Full (strict) requirements](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
apply to Cloudflare → Traefik, independently of the private HTTP app hop.

The labels enable HSTS for this hostname for one year, without preload or
includeSubDomains. There is no application HTTP-to-HTTPS redirect to loop behind
the proxy. Forms, assets and redirects use relative URLs. Secure admin cookies
and CSRF origin checks depend on `PUBLIC_ORIGIN`, not caller-supplied forwarded
host/protocol values.

## Restrict origin access

Restrict the origin's public HTTPS listener at the firewall/security group to
the current [Cloudflare IPv4](https://www.cloudflare.com/ips-v4) and
[IPv6](https://www.cloudflare.com/ips-v6) ranges. Cover both address families;
do not leave an AAAA address or alternative public listener open. If sharing a
listener with non-Cloudflare sites, use a dedicated listener/IP or per-host TLS
authentication rather than excluding their legitimate traffic. Keep host port
3000 and PostgreSQL 5432 closed. Verify this from outside the Docker host.

For origin authentication, configure Traefik to require a client certificate
with Cloudflare's [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).
Use an account-specific zone/per-hostname certificate when restricting requests
to your own Cloudflare account: the global shared certificate only establishes
Cloudflare-network origin. Certificates and listener/firewall changes belong
to the existing proxy infrastructure. The app needs no extra secret/header.

## Forwarded client addresses

Use the same reviewed, current Cloudflare ranges in the firewall, Traefik and
app. On the existing Traefik HTTPS entrypoint set
`forwardedHeaders.trustedIPs` to **only Cloudflare ranges**; leave
`forwardedHeaders.insecure` false. This is Traefik static configuration, not a
per-container Docker label. Do not set blanket forwarding or PROXY-protocol
trust. See [Traefik forwarded headers](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/#forwarded-headers).

For example, merge this into the existing Traefik static config (ranges checked
against Cloudflare's lists on 2026-11-26; re-fetch/review before applying):

```yaml
entryPoints:
  websecure:
    address: ':443'
    forwardedHeaders:
      insecure: false
      trustedIPs:
        - 173.245.48.0/20
        - 103.21.244.0/22
        - 103.22.200.0/22
        - 103.31.4.0/22
        - 141.101.64.0/18
        - 108.162.192.0/18
        - 190.93.240.0/20
        - 188.114.96.0/20
        - 197.234.240.0/22
        - 198.41.128.0/17
        - 162.158.0.0/15
        - 104.16.0.0/13
        - 104.24.0.0/14
        - 172.64.0.0/13
        - 131.0.72.0/22
        - 2400:cb00::/32
        - 2606:4700::/32
        - 2803:f800::/32
        - 2405:b500::/32
        - 2405:8100::/32
        - 2a06:98c0::/29
        - 2c0f:f248::/32
```

Give Traefik a stable address on the external Docker network. For the app, set
`TRUSTED_PROXY_CIDRS` to that exact address (`/32` for IPv4 or `/128` for IPv6),
plus the Cloudflare ranges. Do not trust the entire shared Docker subnet or add
visitor ranges. The production override requires a nonempty trust list. The
default outside that override is still to ignore forwarded headers.

One way to prepare the app's comma-separated value is:

```sh
collector_cf4="$(curl --fail --silent --show-error https://www.cloudflare.com/ips-v4)"
collector_cf6="$(curl --fail --silent --show-error https://www.cloudflare.com/ips-v6)"
collector_cf_ranges="$(printf '%s\n%s\n' "$collector_cf4" "$collector_cf6" | paste -sd, -)"
# Replace this documentation address with Traefik's actual stable Docker IP:
export TRUSTED_PROXY_CIDRS="192.0.2.10/32,$collector_cf_ranges"
```

Check both downloads succeeded, review the ranges, and update all three layers
together when Cloudflare changes them. Persist the resulting non-secret
infrastructure setting in your deployment configuration. The collector does
not fetch/expand trusted ranges during startup. If Traefik's address changes,
update the explicit trust entry and recreate the app.

The app uses Fastify's IP/CIDR trust traversal. For a visitor that supplied a
spoofed prefix, the expected chain is:

```text
TCP peer: Traefik Docker IP
X-Forwarded-For: spoofed-prefix, visitor-IP, Cloudflare-edge-IP
```

Walking from the TCP peer toward the left stops at the first untrusted hop:
the visitor. Changing the prefix cannot change that result. Untrusted direct
peers cannot claim forwarded identities. The app ignores `CF-Connecting-IP`,
`True-Client-IP` and `Forwarded` for rate-limit identity. Trusting only Traefik
would stop at the Cloudflare edge and group its visitors together; trusting
arbitrary peers would allow spoofing. These expectations are exercised by
`test/proxy.test.ts` using separate visitors and both address families.

Keep Cloudflare's **Remove visitor IP headers** transform disabled, and avoid
Pseudo IPv4 **Overwrite Headers** when retaining actual IPv6 identities. Do not
rewrite the app's X-Forwarded-For chain with an unverified client header. Review
any additional load balancer/Worker that changes this path before extending
trust. See [Cloudflare header behavior](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
and [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy).

## Caching

Use a Cloudflare **Cache Rule → Bypass cache** for the whole collector hostname:

```text
http.host eq "jokes.example.com"
```

This is the default deployment recipe. Apply it with precedence over any broad
Cache Everything/Edge TTL rule and purge old cached collector responses when
changing rules. Do not let Workers or another proxy cache these responses.
Cloudflare documents [cache eligibility and bypass settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

All public form/submission responses are `no-store`. Every admin response,
including errors and JSON attachments, is `private, no-store` with `Vary:
Cookie`. Static CSS/JavaScript alone allow `public, max-age=300`; these may be
cached in browsers while the hostname bypass keeps the shared CDN cache off.
The filenames are not content-hashed, so purge assets or allow their five-minute
lifetime to expire on upgrades. Keep responses carrying authentication cookies
out of shared caches even if adding a static-only CDN rule later.

## Live verification

Record the deployed source/image digest, hostname, Traefik version/trusted
addresses, Cloudflare configuration and date. Local injected requests verify
application behavior; they cannot establish the deployed proxy/firewall setup.

1. Check HTTPS `/health/ready` returns 200. Confirm the certificate/edge mode,
   relative redirects and the absence of mixed-content or redirect loops.
2. Submit both joke types with new/existing/no themes through the public form.
   Login at `/admin`; inspect a Secure, HttpOnly, SameSite=Strict `__Host-`
   cookie, browse the submissions, assign a deck, download JSON and log out.
3. Inspect form/admin/export response headers: no-store, no shared-cache HIT,
   and no cached authentication/CSRF data. Cloudflare may show DYNAMIC or
   BYPASS for the hostname bypass rule. Check anonymous responses separately.
4. From one external test client, send five submissions then a sixth while
   changing supplied X-Forwarded-For/CF-Connecting-IP/Forwarded headers: the
   sixth must still be limited. A second client on a different public IP must
   remain usable. Rehearse login rate limits too; counters reset after a minute.
5. From a non-Cloudflare external connection, verify the origin IP cannot serve
   this hostname directly and that ports 3000/5432 are unreachable. Verify mTLS
   rejects requests without the required origin-pull certificate if enabled.

The owner performs these checks on their configured infrastructure. First live
deployment results are pending until recorded in issue #10.
