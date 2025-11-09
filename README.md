# MeetingListener

## Amaç
Google Meet toplantılarını dinleyip konuşmacı bazlı transcript çıkaran, toplantı özetleri ile görev listeleri üreten bir Chrome eklentisi + hafif arka uç servisi.

## Mimarinin Özeti
- **Chrome eklentisi**
  - `tabCapture` ve `offscreen document` kullanarak Meet sekmesinin sesini chunk halinde backend’e aktarır.
  - Meet DOM’unu gözlemleyerek aktif konuşmacı isimlerini toplar; STT’den gelen speaker tag’leri ile eşler.
  - Popup/side panel UI’si canlı transcript, özet ve görev listelerini gösterir.
- **Backend servisi**
  - Streaming STT (örn. OpenAI Realtime/Whisper API) ile yüksek doğrulukta metne çeviri + speaker diarization yapar.
  - Transcript segmentlerini LLM’e (örn. GPT-4o mini) verip incremental özet ve görev listesi üretir.
  - WebSocket veya SSE ile eklentiye transcript/özet güncellemeleri gönderir.

## Yol Haritası
1. Tab audio capture + backend’e streaming ile PoC transcript akışı.
2. DOM’dan konuşmacı isimlerini çıkarma ve STT speaker eşlemesi.
3. LLM ile özet/görev çıkarımı; JSON formatlı sonuçlar.
4. Gelişmiş UX (not paylaşımı, export, görev entegrasyonları).
5. Performans, izin dokümantasyonu ve Chrome Web Store yayını.

## Repo Yapısı
```
extension/       # Chrome eklentisi (Manifest v3)
server/          # Node.js tabanlı backend iskeleti
```

### Chrome Eklentisi
- `service-worker.js`: tab audio capture başlatma/durdurma, offscreen document yönetimi, popup’a olay yayımı.
- `offscreen.js`: `MediaRecorder` ile sesi `WebSocket` üzerinden backend’e gönderir; speaker snapshot’larını da JSON mesaj olarak backend’e taşır.
- `meet-observer.js`: Google Meet DOM’u üzerinden aktif konuşmacıları saptayıp servis worker’a iletir; speaker snapshot’ları backend’e aktarılır.
- `popup.*`: Kullanıcı backend URL’si girip capture’ı yönetir, transcript/özet ve kişi bazlı görev dağılımını gösterir (deadline yoksa “Süre belirtilmedi” ibaresi düşer).

Geliştirme sırasında Chrome’da **Developer Mode → Load unpacked** diyerek `extension/` klasörünü seçmek yeterli.

### Backend Servisi
- `server/src/index.js`: Express + WebSocket sunucusu ile audio chunk’larını alır, OpenAI Realtime/LLM entegrasyonu için kancalar içerir.
- `.env.example`: Gerekli environment değişkenleri.
- Varsayılan port `8787`; sunucuyu ayağa aldıktan sonra eklentideki backend alanı otomatik olarak `wss://localhost:8787/stream` ile doldurulur. Farklı port kullanırsan hem `.env` hem de eklenti ayarını güncelle.
- `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `TRANSCRIBE_INTERVAL_MS`, `SUMMARY_INTERVAL_MS` gibi ayarlar ile bulut Whisper çağrısı yapılandırılır. ffmpeg binary’sinin sistem PATH’inde olması gerekir (Chrome eklentisinden gelen `audio/webm` chunk’ları WAV’a dönüştürmek için). macOS’ta `brew install ffmpeg`, Ubuntu’da `sudo apt install ffmpeg` yeterlidir.
- Backend gelen WebSocket mesajlarını iki tipe ayırır:
  - Binary audio chunk’ları ffmpeg ile WAV’a çevrilip Whisper API’ye gönderilir.
  - JSON `speaker-snapshot` mesajları aktif konuşmacı listesini ve zaman damgasını içerir; transcript segmentleri bu snapshot’larla eşleştirilerek görevlendirme LLM’ine bağlam sağlar.

> Not: Konuşmacı snapshot’ları DOM’dan alınıp backend’e iletilir; Whisper segmentleri bu snapshot’larla eşleştirilir. Daha hassas diarization için ileride chunk zamanlamasını iyileştirmek veya harici diarization modelleri eklemek gerekebilir.
