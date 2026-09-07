# LOOP iterasyon 1

Kapsam: bu oturumda üretilen 44 dosya (`git diff` boştu; çalışma ağacı temiz olduğu
için kapsam ilk commit'ten HEAD'e uzanan değişiklikler olarak alındı, mockup hariç).

## Adım 0 — deterministik
- Tüm JS dosyaları `node --check`: geçti
- Tüm JSON dosyaları parse: geçti
- i18n anahtar eşliği (en/tr): fark yok
- manifest'te adı geçen tüm dosyalar mevcut

## Ajan bulguları

| Ajan | Toplam | critical | high | medium | low |
|---|---|---|---|---|---|
| SyntaxAgent   |  4 | 0 | 0 | 3 | 1 |
| SecurityAgent | 13 | 0 | 4 | 5 | 4 |
| LogicAgent    | 15 | 1 | 5 | 6 | 3 |
| PerfAgent     | 13 | 1 | 4 | 6 | 2 |
| CrossAgent    |  6 | 0 | 1 | 2 | 3 |
| DesignerAgent | 21 | 1 | 6 | 9 | 5 |
| **Toplam**    | **72** | **3** | **20** | **31** | **18** |

Elenen: 1 (bkz. `.loop/dismissed.json`) — mux.js'in worker'da `window` gerektirdiği
iddiası, remux'un uçtan uca çalıştığı ölçümüyle çürütüldü.
Kapsam dışı / kanıtsız / stil bulgusu: 0.

## Düzeltilenler — critical

1. `segment-worker.js` — Range desteklemeyen indirmede gövde her zaman 0'dan gelir,
   ama yazma `segment.received` offsetine yapılıyordu. Duraklat/devam veya retry
   sonrası kısmi + tam veri uç uca eklenip **dosyayı sessizce bozuyordu**.
2. `state.js` — her motor anlık görüntüsünde (500 ms) tüm görev listesi, segmentler
   dahil, `chrome.storage.local`'a yazılıyordu. Yazımlar birleştirildi; durum
   değişimi ve terminal anlık görüntüler hemen yazılıyor.
3. `ui.css` — `--acc/--ok/--warn/--err` yalnız koyu temada tanımlıydı; açık temada
   ~1.6:1 kontrastla okunamıyordu. Açık tema karşılıkları eklendi.

## Düzeltilenler — high (16)

Motor: duraklatılan HLS bir daha hiç başlamıyordu · `retry()` silme işlemiyle
yarışıyordu · `resume()` ikinci worker açabiliyordu · remux iptali başarısızlık
sayılıp duraklatılan dosyayı TS olarak teslim ediyordu · `#hlsParts` iptal/hata
yolunda sızıyordu · blob URL hata yolunda revoke edilmiyordu.

Service worker: `waitForDownload` dinleyiciyi indirme çözüldükten sonra kuruyordu,
hızlı biten blob teslimleri kaçırılıp görev ASSEMBLING'de asılı kalıyordu · mesaj
işleyici göndereni doğrulamıyordu · `deliver()` gelen URL'i doğrulamadan indiriyordu ·
elle indirmelerde dosya adı Windows'ta yasak karakterleri koruyordu.

Güvenlik: playlist'ten gelen segment ve anahtar adreslerine `credentials:'include'`
ile istek atılıyordu; artık yalnız playlist ile aynı kökene kimlik gönderiliyor.
Pano ayarı yalnız arka planda denetleniyordu, kapalıyken bile kopyalanan adresler
sayfadan çıkıyordu; denetim içerik betiğine ve popup'a taşındı.

Arayüz: anahtar sabit koyu renkteydi (açık temada kapalı/açık ayırt edilemiyordu) ·
enjekte edilen kart sayfa CSS'i tarafından gizlenebiliyordu · anahtarların ve kural
tablosu alanlarının erişilebilir adı yoktu · `barSegments` her yayında yeniden
hesaplanıyordu.

Perf: `sleep()` hız sınırı açıkken her chunk'ta abort dinleyicisi bırakıyordu.

## Senaryo testleri (statik incelemenin bulamadığı)

Range destekli yerel sunucuda 10 senaryo, hepsi geçti:
normal 20MB parçalı · Range'siz 8MB · 1KB · 0 bayt · 404 · geçici 500 · duraklat ·
devam et · iptal · aynı URL iki kez (kopya oluşmuyor).

Senaryo 6 ilk turda kaldı ve **gerçek bir hata** ortaya çıkardı: probe'un yeniden
deneme mantığı yoktu, geçici bir 5xx indirmeyi anında öldürüyordu. Düzeltildi.

Bu turda kendi düzeltmelerimden **iki gerileme** çıktı, ikisi de senaryolarla
yakalandı ve giderildi:
- gönderen denetimi sekmede açılan eklenti sayfalarını da reddediyordu
- yazım birleştirmesi hızlı biten indirmelerin son bayt sayısını kaybediyordu

HLS + remux ayrıca doğrulandı: 129 parça, 487.656.579 bayt, düz MP4.

## Düzeltilmeyenler (medium/low — kullanıcı isterse ayrı iş)

- Motor ilerleme mesajı segmentleri ham gönderiyor; havuzlamak kayıt formatını
  bozar ve devam etmeyi kırardı, bilinçli bırakıldı
- `probe.js` yönlendirmede kimlik bilgisi taşıyor (medium)
- `referrerPolicy:'unsafe-url'` tam URL'i karşı tarafa veriyor (medium)
- Windows ayrılmış cihaz adları (CON, NUL…) temizlenmiyor (medium)
- 0 baytlık kaynakta 416 özel olarak ele alınmıyor (medium)
- Enjekte edilen kartta açık tema yok (medium)
- `web_accessible_resources` gereksiz geniş (low)
- Çeşitli erişilebilirlik iyileştirmeleri: ilerleme çubuğunda `role="progressbar"`,
  kart için odak tuzağı (medium/low)
