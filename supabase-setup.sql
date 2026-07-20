-- ══════════════════════════════════════════════
-- JIG Inspection Dashboard — Supabase Setup (v2: ตารางแยกจริง)
-- รันไฟล์นี้ใน Supabase Dashboard → SQL Editor → New query → Run
--
-- ถ้าเคยรัน supabase-setup.sql เวอร์ชันแรก (ที่สร้างตาราง app_kv) มาก่อน
-- ไม่ต้องลบทิ้งก็ได้ ปล่อยไว้เฉยๆ ไม่กระทบอะไร (แอปเวอร์ชันใหม่ไม่ใช้ app_kv แล้ว)
-- ══════════════════════════════════════════════

-- แผนก
create table if not exists departments (
  id   text primary key,
  name text not null
);

-- Line การผลิต (ขึ้นกับแผนก)
create table if not exists lines (
  id      text primary key,
  dept_id text references departments(id) on delete cascade,
  name    text not null
);

-- JIG แต่ละตัว (ขึ้นกับ Line)
create table if not exists jigs (
  id       text primary key,
  line_id  text references lines(id) on delete cascade,
  name     text not null,
  doc_no   text,
  bg_image text  -- รูปพื้นหลังแผนผัง (base64), เว้นว่างได้
);

-- จุดตรวจสอบของแต่ละ JIG
create table if not exists checkpoints (
  jig_id  text references jigs(id) on delete cascade,
  item_id integer not null,
  label   text,
  sub     text,
  method  text,
  x       numeric,
  y       numeric,
  primary key (jig_id, item_id)
);

-- เทมเพลตหัวข้อตรวจสอบ (ใช้ซ้ำข้ามหลาย JIG)
create table if not exists templates (
  id    text primary key,
  name  text not null,
  items jsonb not null default '[]'
);

-- ประวัติการตรวจสอบ — 1 แถวต่อ 1 รายการตรวจ 1 ครั้ง
create table if not exists history (
  id             text primary key,
  ts             timestamptz,
  dept_id        text,
  dept_name      text,
  line_id        text,
  line_name      text,
  jig_id         text,
  jig_name       text,
  jig_doc_no     text,
  insp_date      date,
  shift          text,
  month          text,
  inspector      text,
  notes          text,
  items          jsonb not null default '[]',   -- รายการผลตรวจ + รูปหลักฐาน
  sig_inspector  text,
  sig_supervisor text,
  created_at     timestamptz default now()
);

-- เปิด Row Level Security ทุกตาราง + Policy ให้ทีมอ่าน/เขียนได้ (internal tool)
alter table departments enable row level security;
alter table lines        enable row level security;
alter table jigs         enable row level security;
alter table checkpoints  enable row level security;
alter table templates    enable row level security;
alter table history      enable row level security;

create policy "allow all" on departments for all using (true) with check (true);
create policy "allow all" on lines        for all using (true) with check (true);
create policy "allow all" on jigs         for all using (true) with check (true);
create policy "allow all" on checkpoints  for all using (true) with check (true);
create policy "allow all" on templates    for all using (true) with check (true);
create policy "allow all" on history      for all using (true) with check (true);

-- เปิด Realtime ให้ทุกตาราง (ให้ทุกเครื่องเห็นข้อมูลอัปเดตทันทีแบบ live)
alter publication supabase_realtime add table departments;
alter publication supabase_realtime add table lines;
alter publication supabase_realtime add table jigs;
alter publication supabase_realtime add table checkpoints;
alter publication supabase_realtime add table templates;
alter publication supabase_realtime add table history;

-- (ทางเลือก) ลบตาราง app_kv เวอร์ชันเก่าทิ้ง ถ้าไม่ใช้แล้วและอยากเคลียร์ให้สะอาด
-- drop table if exists app_kv;
