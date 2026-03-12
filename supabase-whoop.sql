-- Run this in Supabase SQL editor
create table if not exists whoop_tokens (
  id            int primary key default 1,
  access_token  text not null,
  refresh_token text not null,
  expires_at    bigint not null,
  updated_at    timestamptz default now()
);
