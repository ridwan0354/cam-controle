#!/bin/bash
# ============================================================
# DEPLOY SCRIPT — Mobile Camera to OBS
# Domain  : cam.galipatsistem.com
# ============================================================
# Jalankan sekali di VPS dengan:
#   bash deploy.sh
# ============================================================

set -e  # Hentikan jika ada error

# -------- VARIABEL --------
APP_NAME="cam-controller"
APP_DIR="/var/www/cam-controller"
REPO_URL="https://github.com/ridwan0354/cam-controle.git"
DOMAIN="cam.galipatsistem.com"
PORT=3100   # Port internal Node.js (beda dari app lain di VPS)
NODE_ENV="production"

echo ""
echo "============================================================"
echo "  📡 Deploy: Mobile Camera to OBS"
echo "  Domain : $DOMAIN"
echo "  Port   : $PORT"
echo "============================================================"
echo ""

# -------- 1. UPDATE SISTEM --------
echo "[1/8] Update sistem..."
apt-get update -qq

# -------- 2. INSTALL NODE.JS & FFMPEG (jika belum ada) --------
echo "[2/8] Cek & install Node.js & FFmpeg..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "  ✅ Node.js $(node -v) terinstall"
else
  echo "  ✅ Node.js sudah ada: $(node -v)"
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "  Menginstal FFmpeg..."
  apt-get install -y ffmpeg
  echo "  ✅ FFmpeg terinstall"
else
  echo "  ✅ FFmpeg sudah ada: $(ffmpeg -version | head -n 1)"
fi

# -------- 3. INSTALL PM2 (jika belum ada) --------
echo "[3/8] Cek & install PM2..."
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2 --silent
  echo "  ✅ PM2 terinstall"
else
  echo "  ✅ PM2 sudah ada: $(pm2 -v)"
fi

# -------- 4. CLONE / UPDATE REPO --------
echo "[4/8] Clone / update repository..."
if [ -d "$APP_DIR" ]; then
  echo "  Direktori sudah ada, pull update..."
  cd "$APP_DIR"
  git pull origin main
else
  echo "  Clone repository baru..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# -------- 5. INSTALL DEPENDENCIES --------
echo "[5/8] Install Node dependencies..."
npm install --production --silent
echo "  ✅ Dependencies terinstall"

# -------- 6. JALANKAN / RESTART DENGAN PM2 --------
echo "[6/8] Jalankan aplikasi dengan PM2..."
if pm2 list | grep -q "$APP_NAME"; then
  echo "  App sudah berjalan, restart..."
  pm2 restart "$APP_NAME"
else
  echo "  Mulai app baru..."
  PORT=$PORT pm2 start server.js --name "$APP_NAME" \
    --env production \
    -- --port $PORT
fi
pm2 save
echo "  ✅ App berjalan di port $PORT"

# -------- 7. KONFIGURASI NGINX --------
echo "[7/8] Setup Nginx untuk $DOMAIN..."

NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"

cat > "$NGINX_CONF" << EOF
# ============================================================
# Nginx Config — $DOMAIN
# Reverse proxy ke Node.js di port $PORT
# ============================================================

server {
    listen 80;
    server_name $DOMAIN;

    # Redirect HTTP ke HTTPS (aktif setelah Certbot dijalankan)
    # Untuk sementara, comment baris di bawah dan uncomment server block HTTP

    # Untuk sementara layani via HTTP dulu:
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;

        # WebSocket support (WAJIB untuk Socket.io)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Timeout lebih panjang untuk koneksi WebSocket
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Route traffic WebSocket-FLV ke Node-Media-Server secara aman (SSL)
    location /live/ {
        proxy_pass http://127.0.0.1:$((PORT + 1));
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

# Aktifkan site
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN"

# Test & reload Nginx
nginx -t && systemctl reload nginx
echo "  ✅ Nginx dikonfigurasi untuk $DOMAIN"

# -------- 8. SSL DENGAN CERTBOT --------
echo "[8/8] Setup SSL (Certbot)..."
if ! command -v certbot &> /dev/null; then
  apt-get install -y certbot python3-certbot-nginx -qq
fi

# Jalankan Certbot (akan otomatis update nginx config dengan HTTPS)
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --email admin@galipatsistem.com --redirect
echo "  ✅ SSL aktif! Site HTTPS siap."

# -------- SELESAI --------
echo ""
echo "============================================================"
echo "  🎉 DEPLOY SELESAI!"
echo "============================================================"
echo "  🌐 URL Publik  : https://$DOMAIN"
echo "  📱 Link HP     : https://$DOMAIN/kamera.html?room=XXXXXX"
echo "  🎬 Link OBS    : https://$DOMAIN/obs.html?room=XXXXXX"
echo "  📊 Status PM2  : pm2 status"
echo "  📋 Log App     : pm2 logs $APP_NAME"
echo "============================================================"
echo ""
echo "  ⚡ PM2 akan otomatis restart jika VPS reboot."
echo "     Untuk set startup: pm2 startup && pm2 save"
echo ""
