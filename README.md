<p align="center">
  <img src="client/public/icon.png" width="96" alt="AnucVC" />
</p>

<h1 align="center">AnucVC</h1>

<p align="center">
  Discord'dan ilham alan, kendi kendine barındırılan sohbet + sesli/görüntülü konuşma uygulaması.<br/>
  Web ve masaüstü (Tauri) üzerinde çalışır, kendi yapay zeka maskotu <b>AnucAI</b> ile birlikte gelir.
</p>

## Özellikler

- **Metin kanalları** — oluşturma, yeniden adlandırma, silme, sürükle-bırak sıralama, resim gönderme, mesaj düzenleme/silme, yanıtlama
- **Sesli/görüntülü kanallar** — WebRTC tabanlı sesli sohbet, ekran paylaşımı, kamera, mute/deafen durumu
- **Arkadaşlar & DM** — arkadaşlık istekleri, özel mesajlar, okunmamış mesaj rozetleri
- **AnucAI** — Groq (Llama/GPT-OSS) destekli, her yeni kullanıcıyla otomatik arkadaş olan yapay zeka maskotu; kanallarda `@AnucAI` ile ya da DM üzerinden konuşulabilir
- **Bildirimler** — masaüstü bildirimleri ve servis çalışanı (service worker) ile arka planda bildirim
- **Masaüstü uygulaması** — Tauri ile Windows/macOS/Linux için native derleme, web ile aynı `dist` çıktısını kullanır

## Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| İstemci | Vanilla JS + Vite, Socket.io-client, Tauri |
| Sunucu | Fastify + Socket.io + better-sqlite3 |
| AnucAI servisi | Python, FastAPI, Groq API |

## Proje Yapısı

```
AnucVC/
├── client/          # Vite tabanlı web istemcisi + Tauri masaüstü kabuğu
│   ├── src/         # app.js (uygulama mantığı), webrtc.js (sesli/görüntülü)
│   └── src-tauri/   # Tauri (Rust) masaüstü paketleme yapılandırması
├── server/          # Fastify + Socket.io + SQLite backend
└── ai-service/       # AnucAI için ayrı Python FastAPI mikroservisi (Groq)
```

## Kurulum

Gereksinimler: Node.js 20.19+ (önerilen: 22 LTS), Python 3.10+ (AnucAI için), bir [Groq API anahtarı](https://console.groq.com) (AnucAI için), isteğe bağlı bir [GIPHY API anahtarı](https://developers.giphy.com/dashboard/) (GIF seçici için).

```bash
# Bağımlılıklar
npm --prefix server install
npm --prefix client install
```

AnucAI servisi için:

```bash
cd ai-service
python -m venv .venv
.venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env     # ve GROQ_API_KEY değerini doldurun
```

## Geliştirme

Üç servisi ayrı terminallerde çalıştırın:

```bash
npm run server     # backend (Fastify + Socket.io) -> :8080
npm run client      # Vite dev server (frontend)
cd ai-service && uvicorn main:app --host 127.0.0.1 --port 8001   # AnucAI servisi
```

## Derleme

```bash
npm run build       # client/dist üretir (hem web hem Tauri bu klasörü kullanır)
npm run tauri build # masaüstü uygulaması paketler
```

## Testler

```bash
npm --prefix server test   # güvenlik regresyon testleri (geçici veritabanı + port ile gerçek sunucuyu başlatır)
```

## Yapılandırma

`server/.env.example` dosyasını `server/.env` olarak kopyalayın. Tüm değerler
opsiyoneldir; dosya hiç yoksa sunucu varsayılanlarla başlar.

| Değişken | Ne işe yarar |
|---|---|
| `AUTH_SECRET` | Oturum token'larını imzalayan gizli anahtar (en az 32 karakter). Boşsa ilk açılışta rastgele üretilip `server/.auth-secret` dosyasına yazılır. |
| `GIPHY_API_KEY` | GIF seçici. Anahtar yalnızca sunucuda durur; istemciler `GET /api/gifs` üzerinden arar. |
| `AI_SERVICE_URL` | AnucAI Python servisinin adresi (varsayılan `http://127.0.0.1:8001`). |
| `HOST` / `PORT` | Dinlenen arayüz ve port. Aynı makinede reverse proxy / Cloudflare Tunnel varsa `HOST=127.0.0.1`. |
| `UPDATE_UPLOAD_SECRET` | CI'ın masaüstü güncelleme dosyalarını yüklediği uç nokta için paylaşılan sır. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | İsteğe bağlı TURN aktarıcısı (aşağıya bakın). |

API anahtarları ve sırlar yalnızca `.env` dosyalarında tutulur; bu dosyalar
`.gitignore` ile repodan hariç tutulur.

## Güvenlik

- Oturumlar HMAC-SHA256 ile imzalı token'larla doğrulanır; socket bağlantısının
  kimliği de yalnızca bu token'dan alınır (istemcinin gönderdiği kullanıcı adı/ID'ye güvenilmez).
  Şifre değişince eski oturumlar geçersiz olur.
- DM'ler yalnızca iki katılımcısına iletilir ve yalnızca onlar okuyabilir.
- Kanal oluşturma/silme/yeniden adlandırma/sıralama ve kullanıcı silme yalnızca admin içindir
  (ilk kayıt olan kullanıcı otomatik admin olur).
- Profil fotoğrafı, kapak ve sohbet görselleri yalnızca geçerli görsel verisi (veya GIPHY adresi)
  olarak kabul edilir; giriş/kayıt ve mesaj gönderimi hız sınırlıdır.

Bir güvenlik açığı bulursanız lütfen herkese açık bir issue yerine depo sahibiyle doğrudan iletişime geçin.

Sesli sohbet çoğu kullanıcı için yalnızca STUN ile çalışır. Simetrik NAT
arkasındaki kullanıcılar için bir TURN aktarıcısı gerekir: `TURN_URL`
(gerekirse `TURN_USERNAME` / `TURN_CREDENTIAL`) tanımlandığında hem tarayıcı/
masaüstü istemcileri hem de sunucu üzerinden aktarılan CS2 ROOM bunu
otomatik kullanır — istemciler listeyi `GET /api/ice-servers` üzerinden
aldığı için yeniden derleme gerekmez.

## Dağıtım

`server/` Node.js çalıştırabilen herhangi bir ortamda (ör. PM2 ile) barındırılabilir; `client/dist` statik olarak sunulur. `ai-service/` ayrı bir process olarak çalışmalı ve kendi `.env` dosyasına (`GROQ_API_KEY`) ihtiyaç duyar.

Masaüstü uygulaması `client/src-tauri/tauri.conf.json` içindeki sunucu adresine
(`updater.endpoints`, `security.csp`) ve `client/src/app.js` içindeki `serverUrl`
değerine bağlanır; kendi sunucunuzu kullanacaksanız bu adresleri değiştirip
yeniden derleyin.

## Lisans

[MIT](LICENSE) — kodu kullanabilir, değiştirebilir ve dağıtabilirsiniz; tek şart
lisans metninin ve telif bildiriminin korunmasıdır. Yazılım "olduğu gibi",
hiçbir garanti olmadan sunulur.
