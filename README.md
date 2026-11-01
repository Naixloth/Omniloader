# Omniİndir — Evrensel Video & Ses İndirici (Windows PC + iPhone 15)

YouTube, Instagram (Reels, Post, Story), X (Twitter), TikTok, Reddit, Twitch, Kick, Facebook, Vimeo, SoundCloud ve **1.800'den fazla** platformdan yüksek kalitede video ve ses indirmenizi sağlayan yerel web uygulaması.

## Özellikler
- **Kalite & Format Seçimi**: 4K (2160p), 2K, 1080p Full HD, 720p MP4 video veya kapak resimli MP3 (320 kbps), M4A (Apple AAC) ve WAV ses indirme.
- **iPhone 15 Tam Uyumluluk Modu**: İndirilen videolar H.264 / `hvc1` + AAC ses akışıyla optimize edilir; iPhone Safari üzerinden **Fotoğraflara / Paylaş → Videoyu Kaydet** seçeneğiyle doğrudan **iPhone Galeri (Fotoğraflar)** uygulamasına kaydedilebilir.
- **Zaman Aralığı Kesici (Klip İndirme)**: Uzun bir videonun tamamını indirmek yerine yalnızca istediğiniz başlangıç-bitiş aralığını (ör. `01:15` - `02:30`) keserek indirir.
- **Toplu Link & Oynatma Listesi (Playlist) Desteği**: YouTube oynatma listelerini, çoklu Instagram/X gönderilerini veya alt alta yapıştırılmış onlarca bağlantıyı tek seferde sıraya ekler.
- **Tarayıcı Çerezi (Cookie) Desteği**: Giriş gerektiren Instagram/X videoları için `cookies.txt` yükleme veya tarayıcıdan okuma.
- **iPhone 15 QR Bağlantısı & 5G HTTPS Tüneli**: Ev Wi-Fi ağında QR kodla anında bağlanma veya Cloudflare Quick Tunnel ile ev dışından (5G/LTE) güvenli HTTPS erişimi.

## ☁️ PC Kapalıyken 7/24 Kullanım (%100 Ücretsiz Bulut Kurulumu — Kredi Kartı Yok)

Bilgisayarınız tamamen kapalıyken bile iPhone 15 veya herhangi bir cihazdan 7/24 erişmek için:

1. Klasördeki `Buluta_Yukle.bat` dosyasına çift tıklayın.
2. Sihirbazın açtığı GitHub sayfasında en alttaki yeşil **Generate token** butonuna basıp `ghp_...` kodunu yapıştırın (bilgisayarınıza Git kurmanıza gerek kalmadan tüm dosyaları otomatik olarak GitHub deponuza yükler ve depo linkini panonuza kopyalar).
3. Sihirbazın açtığı **Render.com (`New Web Service`)** sayfasında:
   - **Public Git repository** kutusuna depo linkinizi yapıştırın (`Ctrl+V`).
   - **Instance Type** bölümünden **Free (\$0/month)** seçeneğini işaretleyin *(kredi kartı istemez)*.
   - **Environment Variables** kısmına `APP_PASSWORD` anahtarını ve belirlediğiniz şifreyi (ör. `174190`) ekleyin.
   - **Deploy Web Service** butonuna basın!
4. 3–4 dakika içinde size verilen kalıcı `https://...onrender.com` adresini iPhone 15 Safari'de açıp **Paylaş → Ana Ekrana Ekle** diyerek PC kapalıyken bile her yerden kullanabilirsiniz!

## 💻 Yerel Başlangıç (Yalnızca PC Açıkken)

1. **Çalıştırma**: Klasördeki `Baslat.bat` dosyasına çift tıklayın (veya terminalde `.venv\Scripts\python.exe run.py --open` komutunu çalıştırın).
2. **Windows PC**: Tarayıcınızda otomatik olarak `http://localhost:8000` açılır.
3. **iPhone 15**: Sağ üstteki **"📱 iPhone 15 Bağlantısı"** butonuna tıklayıp ekrandaki QR kodu iPhone kameranızla okutun. Safari'de **Paylaş → Ana Ekrana Ekle** diyerek tam ekran uygulama olarak kullanabilirsiniz.
4. **Güncelleme**: İleride platformlar altyapı değiştirdiğinde `Guncelle.bat` dosyasına çift tıklayarak indirme motorunu tek tıkla güncelleyebilirsiniz.
