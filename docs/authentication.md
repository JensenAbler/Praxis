# Persistent Praxis authorization

Owner-approved connections renew independently of the browser session, including native clients that omit offline_access. Browser sign-in cookies still expire after seven days; their expiry does not invalidate API refresh tokens.

Access tokens last ten minutes. Refresh tokens rotate on every use and expire after 90 days without renewal. Issuing a refresh token extends its existing, unexpired authorization grant to at least the same deadline. Active use therefore does not hit a fixed 30-day grant deadline. Revocation, refresh-token reuse detection, client authentication, PKCE, resource restrictions, and granted scopes remain enforced. Revoked or expired grants are never recreated by renewal.

The September 16 regression reproduced the native client's missing offline_access scope: deleting its browser session caused token renewal to fail. Tests now cover renewal without that session, grant extension, restart recovery, and replay revocation.

An existing connection may need one reconnect after deployment because its old token records retain their session binding, or because the client already discarded its token. The owner-only migration utility can detach still-unexpired token records from the old browser session when their original, unexpired owner grant remains valid. It preserves token values, scopes, deadlines, and consumed markers, including replay evidence. It does not recover expired or revoked grants.
