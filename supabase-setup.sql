-- ══════════════════════════════════════════════
-- JIG Inspection Dashboard — Supabase Setup
-- รันไฟล์นี้ใน Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════

create table if not exists app_kv (
  key        text primary key,       -- 'catalog' หรือ 'history'
  value      jsonb not null,
  updated_at timestamptz default now()
);

-- เปิด Row Level Security
alter table app_kv enable row level security;

-- Policy: ให้ทุกคนที่มี anon key อ่าน/เขียนได้ (เหมาะกับ internal tool ในทีม)
create policy "allow all" on app_kv
  for all using (true) with check (true);

-- เปิด Realtime สำหรับตารางนี้ (ให้ทุกเครื่องเห็นข้อมูลอัปเดตทันทีแบบ live)
alter publication supabase_realtime add table app_kv;
