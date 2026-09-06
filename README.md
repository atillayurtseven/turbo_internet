# chrome_dlman

Dosya tipi tanıyan, kural bazlı **parçalı (multi-connection)** Chrome indirme yöneticisi.

## Durum
- [x] Mockup — `mockup/index.html`
- [x] MV3 eklenti çekirdeği — `extension/`
- [x] Range probe + segmentli indirme motoru + OPFS
- [x] i18n (en / tr, çalışma anında değiştirilebilir)
- [ ] Torrent (native messaging yardımcısı ile, ayrı aşama)

## Kurulum
`chrome://extensions` → Geliştirici modu → **Paketlenmemiş öğe yükle** → `extension/` klasörü.

## Mimari

    ┌─ service worker ─────────┐   coordinator
    │ interceptor  rules       │   • chrome.downloads.onDeterminingFilename ile yakala
    │ settings     state       │   • bitmiş blob'u chrome.downloads'a ver
    └───────────┬──────────────┘
                │ chrome.runtime mesajları
    ┌───────────┴──────────────┐   offscreen document (30 sn idle timeout'a tabi değil)
    │ engine  probe  opfs      │   • kuyruk, eşzamanlılık, hız, ilerleme
    └───────────┬──────────────┘
                │ Worker (indirme başına bir tane)
    ┌───────────┴──────────────┐
    │ segment-worker           │   • N paralel Range fetch
    │ FileSystemSyncAccessHandle│  • her chunk doğrudan kendi byte offset'ine yazılır
    └──────────────────────────┘

**Neden offscreen document?** MV3 service worker'ı ~30 sn boşta kalınca öldürülür ve
`URL.createObjectURL` service worker'da yok. Offscreen belge her ikisini de çözer.

**Neden parça başına ayrı OPFS dosyası?** Ölçtük: OPFS'te tek bir dosyayı ~2 GB üstüne
`truncate()` ile büyütmek **sessizce başarısız oluyor** — hata fırlatmıyor, dosya 0 byte
kalıyor (kota 11 GB olsa bile). Bu yüzden her segment kendi dosyasına yazılır ve sonda
`new Blob([p0, p1, ...])` ile birleştirilir. Blob parçaları diskteki dosyalara referans
verir, belleğe okunmaz. Segment sayısı, hiçbir parça 1 GB'ı geçmeyecek şekilde artırılır.

## Akış
1. `onDeterminingFilename` → kural eşleşmesi → eşleşirse Chrome indirmesi iptal + erase
2. `GET Range: bytes=0-0` probe → `Content-Range` toplam boyutu ve 206 range desteğini verir
   (HEAD birçok CDN'de yanıltıcı olduğu için tercih edilmedi)
3. Segment planı → worker → paralel indirme, parça başına retry + exponential backoff
4. Bitince blob URL → `chrome.downloads.download()` → `.part` silinir

## Kullanıcıya sorma
Varsayılan mod **"her seferinde sor"**. Eşleşen bir indirme başlayınca Chrome'un indirmesi
duraklatılır ve aktif sekmenin sağ üstünde bir kart çıkar. "Yönetici ile indir" → Chrome
indirmesi iptal edilip motora devredilir. "Hayır" / Esc / 20 sn sessizlik → Chrome'un
indirmesi kaldığı yerden devam eder. Kart enjekte edilemeyen sayfalarda (chrome://, Web
Store, PDF görüntüleyici) soru sorulmaz ve indirme Chrome'da kalır.

Ayarlardan "her zaman devral" veya "asla devralma" seçilebilir.

## Work stealing
Erken biten bir bağlantı boşta beklemez: en çok işi kalan parçayı ikiye böler ve kuyruk
yarısını devralır. Korumalar:
- kalan iş 2 MB'ın altındaysa bölünmez (bağlantı maliyeti kazancı aşar)
- dosyanın %90'ı bittikten sonra hiç bölünmez
- toplam parça sayısı 32'yi geçemez

Bu üçü birlikte bölmenin kendi kuyruğunu kovalamasını imkânsız kılar: her bölme en az
1 MB'lık yeni iş yaratır ve toplam boyut sonludur.

## Doğrulama
Uçtan uca test, Chrome'u `--load-extension` ile başlatıp CDP üzerinden konsolu okuyarak
yapıldı (`--disable-features=DisableLoadExtensionCommandLineSwitch` gerekiyor; Chrome 137+
bu anahtarı varsayılan olarak kapatıyor). 10 MB'lık bir dosya 4 parça hâlinde indirildi;
sonucun SHA-256'sı sunucudaki dosyayla birebir aynı çıktı.

Work stealing ayrıca Range destekli yerel bir test sunucusuyla doğrulandı: dosyanın son
çeyreği kasıtlı yavaşlatıldı, 3 bölme tetiklendi (seg3→seg4, seg3→seg5, seg4→seg6) ve
40 MB'lık sonucun SHA-256'sı referansla birebir eşleşti.

## Bilinen sınırlar
- Tek bağlantıya düşen (Range desteklemeyen) sunucularda dosya 1 GB'ı geçemez.
- Dosya diske yazılana kadar tarayıcı depolamasında bir kopyası durur; 6 GB'lık bir ISO
  geçici olarak ~13 GB yer ister. Kota yetmezse indirme baştan reddedilir.
- `Referer`, fetch'te yasaklı bir header. `referrer` + `referrerPolicy: 'unsafe-url'` ile
  aktarılıyor; katı hotlink korumalı sunucularda declarativeNetRequest kuralı gerekebilir.
- Range desteklemeyen sunucularda duraklat/devam et yoktur — devam, baştan başlatır.
- Tarayıcı yeniden başladığında aktif indirmeler *paused* olarak geri gelir; `.part`
  dosyaları OPFS'te durduğu için kaldıkları yerden devam ederler.

## Dil ekleme
`src/locales/<kod>.json` ekle ve `src/shared/i18n.js` içindeki `SUPPORTED_LOCALES`
listesine kodu yaz. `_locales/` yalnızca manifest metinleri içindir.

## Yapılacaklar
- Native messaging yardımcısı (torrent + Range'siz sunucularda devam)
- İndirme geçmişi sayfası
- Bağlam menüsünden "bunu parçalı indir"
