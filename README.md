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

**Neden OPFS + SyncAccessHandle?** Parçalar RAM'de biriktirilmez; tek bir `.part` dosyasına
offset'lerine yazılır. Sonda `getFile()` diskle desteklenen bir `File` döndürür, ondan
üretilen blob URL'i dosyayı belleğe okumaz — çok GB'lık indirmeler bu yüzden sorun olmuyor.

## Akış
1. `onDeterminingFilename` → kural eşleşmesi → eşleşirse Chrome indirmesi iptal + erase
2. `GET Range: bytes=0-0` probe → `Content-Range` toplam boyutu ve 206 range desteğini verir
   (HEAD birçok CDN'de yanıltıcı olduğu için tercih edilmedi)
3. Segment planı → worker → paralel indirme, parça başına retry + exponential backoff
4. Bitince blob URL → `chrome.downloads.download()` → `.part` silinir

## Bilinen sınırlar
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
