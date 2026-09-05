# chrome_dlman

Chrome için dosya tipi tanıyan, kural bazlı **parçalı (multi-connection)** download manager.

## Durum
- [x] Mockup — `mockup/index.html`
- [ ] MV3 eklenti iskeleti
- [ ] Range/parça motoru
- [ ] Native messaging yardımcısı (büyük dosyalar için)

## Karar noktası: Extension mi App mi?
Chrome App'ler (packaged apps) 2022'de kaldırıldı. Tek uygulanabilir yol **MV3 eklentisi**:
- `chrome.downloads.onDeterminingFilename` ile indirmeyi yakala → iptal et
- `HEAD` ile `Accept-Ranges` / `Content-Length` kontrolü
- Destekliyorsa N paralel `fetch` + `Range: bytes=a-b`
- Parçalar OPFS'e yazılır → birleştir → `chrome.downloads.download(blobUrl)`
- Desteklemiyorsa tek bağlantıya fallback

**Sınır:** OPFS/bellek nedeniyle çok büyük dosyalarda (4 GB+) zorlanır. O senaryo için
2. aşamada **Native Messaging + yerel yardımcı** (Rust/Go) eklenmeli.

## Çalıştırma
    open mockup/index.html
