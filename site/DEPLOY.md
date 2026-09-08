# Deploying turbointernet.com

The site is three static files. It is served from the same host as
`status.handycafe.com` — `172.236.217.138` at the time of writing.

## 1. DNS (Route 53)

The domain's nameservers already point at Route 53, but the hosted zone has no
records, which is why nothing resolves today. Add two:

| Name                 | Type | Value           | TTL |
|----------------------|------|-----------------|-----|
| turbointernet.com    | A    | 172.236.217.138 | 300 |
| www.turbointernet.com| A    | 172.236.217.138 | 300 |

Check before going further — TLS issuance fails until these resolve:

    dig +short turbointernet.com

## 2. Files

    sudo mkdir -p /var/www/turbointernet
    sudo rsync -av --delete ./ /var/www/turbointernet/ \
        --exclude nginx-turbointernet.conf --exclude DEPLOY.md
    sudo chown -R www-data:www-data /var/www/turbointernet

## 3. nginx

    sudo cp nginx-turbointernet.conf /etc/nginx/sites-available/turbointernet.com
    sudo ln -s /etc/nginx/sites-available/turbointernet.com /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

## 4. TLS

    sudo certbot --nginx -d turbointernet.com -d www.turbointernet.com

Both names are on the certificate even though only the bare domain serves
content: without it, `https://www.…` would warn before the redirect could run.
Certbot edits both blocks to listen on 443 and redirects port 80 to HTTPS.
Renewal runs from its own timer; nothing else to schedule.

After it finishes, check the redirect survived the rewrite:

    curl -sI https://www.turbointernet.com/ | head -2

## 5. Check

    for u in / /privacy /llms.txt /llms-full.txt /robots.txt /sitemap.xml; do
        curl -sI "https://turbointernet.com$u" | head -1
    done

`/privacy` is the address given to the Chrome Web Store as the privacy policy.
Keep it working: a listing is rejected when the policy URL is dead.

Both duplicates must redirect rather than answer, or the two pages compete with
themselves in the index:

    curl -sI https://turbointernet.com/index.html | head -1   # 301
    curl -sI https://turbointernet.com/privacy.html | head -1 # 301

Finally, submit the sitemap in Google Search Console. A new domain with no
inbound links otherwise sits undiscovered for weeks.
