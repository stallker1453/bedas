# Son Saha - Kalıcı Veritabanı Sürümü

Bu sürüm Render'ın geçici dosya sistemindeki SQLite yerine PostgreSQL kullanır. Render'da `DATABASE_URL` ortam değişkeni Supabase bağlantı adresine ayarlanmalıdır.

## Render Environment Variables

- `DATABASE_URL` = Supabase PostgreSQL bağlantı adresi
- `ADMIN_KEY` = yönetici şifreniz

## Önemli

Eski SQLite veritabanı Render'ın geçici diskinde kaldıysa otomatik olarak taşınamaz. Bu sürüm yeni Supabase veritabanında tabloları ilk açılışta otomatik oluşturur.
