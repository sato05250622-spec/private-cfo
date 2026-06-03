-- 顧客番号 client_no: 5400から登録順に降順・永続・再利用なし
alter table public.profiles add column if not exists client_no integer unique;

update public.profiles set client_no = 5400
  where email = 'freeder0324@gmail.com' and client_no is null;

create sequence if not exists public.client_no_seq
  as integer increment by -1 minvalue 1 maxvalue 5400 start with 5399 no cycle
  owned by public.profiles.client_no;

create or replace function public.assign_client_no()
returns trigger language plpgsql as $$
begin
  if new.role = 'client' and new.client_no is null then
    new.client_no := nextval('public.client_no_seq');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_client_no on public.profiles;
create trigger trg_profiles_client_no
  before insert on public.profiles
  for each row execute function public.assign_client_no();
