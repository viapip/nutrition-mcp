-- Standalone production migration: personal per-user product memory.
create table personal_products (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    name text not null,
    barcode text,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    nutrition_source text not null check (
        nutrition_source in ('estimate', 'barcode', 'dish', 'manual')
    ),
    last_eaten_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint personal_products_nutrients_nonnegative check (
        calories >= 0 and protein_g >= 0 and carbs_g >= 0 and fat_g >= 0
    )
);

create unique index uniq_personal_products_user_lower_name
on personal_products (user_id, lower(name));

create index idx_personal_products_user_barcode
on personal_products (user_id, barcode)
where
    barcode is not null;
