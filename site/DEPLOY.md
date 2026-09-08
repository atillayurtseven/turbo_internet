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

Certbot edits the server block to listen on 443 and redirect from 80. Renewal
is handled by its own timer; nothing else to schedule.

## 5. Check

    curl -I https://turbointernet.com/
    curl -I https://turbointernet.com/privacy

The second address is the one given to the Chrome Web Store as the privacy
policy. Keep it working: a listing is rejected when the policy URL is dead.
