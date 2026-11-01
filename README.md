# Omniloader

Minimalist, OLED siyah + Liquid Glass tasarımlı evrensel video ve ses indirici (Windows PC & iOS / Mobil uyumlu).

## Özellikler
- **Kalite ve Format Seçimi**: 4K (2160p), 2K, 1080p Full HD, 720p MP4 video veya kapak resimli MP3 (320 kbps), M4A (Apple AAC) ve WAV ses indirme.
- **iOS ve Galeri Uyumluluğu**: İndirilen videolar H.264 / `hvc1` + AAC ses akışıyla optimize edilir; iOS Safari üzerinden **Paylaş → Videoyu Kaydet** ile doğrudan Fotoğraflar uygulamasına kaydedilir.
- **Zaman Aralığı Kesici**: Uzun bir videonun yalnızca seçtiğiniz başlangıç-bitiş aralığını (`01:15` - `02:30`) indirir.
- **Toplu Bağlantı ve Oynatma Listesi**: Oynatma listelerini, çoklu gönderileri veya alt alta yapıştırılan bağlantıları tek seferde sıraya ekler.
- **Çerez (Cookie) Desteği**: Giriş veya doğrulama gerektiren içerikler için `cookies.txt` ve `COOKIES_BASE64` desteği.

## 7/24 Bulut Kurulumu ve Güncelleme (GitHub + Render Free)

1. Klasördeki `Buluta_Yukle.bat` dosyasına çift tıklayın.
2. GitHub Token (`ghp_...`) ve depo adını (`Omniloader`) girin; tüm dosyalar ve ikonlar otomatik olarak GitHub deponuza yüklenir.
3. İlk kurulumda Render üzerinde **New Web Service → Public Git repository** ile depoyu bağlayıp **Free** planı seçin ve `APP_PASSWORD` ortam değişkenini tanımlayın.
4. Sonraki güncellemelerde Render panelinizin sağ üstündeki **Manual Deploy → Deploy latest commit** butonuna tıklamanız yeterlidir.

## Yerel Çalıştırma (Windows PC)

1. Klasördeki `Baslat.bat` dosyasına çift tıklayın (`http://localhost:8000` otomatik açılır).
2. İndirme motorunu en güncel sürüme yükseltmek için `Guncelle.bat` dosyasını çalıştırabilirsiniz.
