-- Keeper database schema for the leveraged mUSDX vault
-- Run this in Supabase SQL editor

-- Operations log: every keeper action
create table if not exists operations (
  id bigint generated always as identity primary key,
  operation_type text not null, -- 'deposit_collateral', 'open_leverage_step', 'close_leverage_step', 'withdraw_collateral', 'refresh_position'
  status text not null default 'pending', -- 'pending', 'submitted', 'confirmed', 'failed'
  tx_signature text,
  error_message text,
  -- operation-specific data
  usdx_amount bigint,
  usdc_amount bigint,
  musdx_amount bigint,
  leverage_bps_before smallint,
  leverage_bps_after smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Position snapshots: periodic state captures
create table if not exists position_snapshots (
  id bigint generated always as identity primary key,
  musdx_collateral bigint not null,
  usdc_debt bigint not null,
  current_leverage_bps smallint not null,
  idle_usdx bigint not null default 0,
  idle_musdx bigint not null default 0,
  idle_usdc bigint not null default 0,
  vault_total_value bigint,
  created_at timestamptz not null default now()
);

-- Pending actions: crash recovery queue
create table if not exists pending_actions (
  id bigint generated always as identity primary key,
  action_type text not null, -- 'deploy', 'unwind', 'unwind_all', 'rebalance'
  status text not null default 'pending', -- 'pending', 'in_progress', 'completed', 'failed'
  target_amount bigint, -- amount to deploy or unwind
  steps_completed int not null default 0,
  steps_total int,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for common queries
create index if not exists idx_operations_status on operations(status);
create index if not exists idx_operations_created on operations(created_at desc);
create index if not exists idx_pending_actions_status on pending_actions(status);
create index if not exists idx_position_snapshots_created on position_snapshots(created_at desc);

-- RLS policies (permissive for server-side keeper)
alter table operations enable row level security;
alter table position_snapshots enable row level security;
alter table pending_actions enable row level security;

-- Allow all operations with anon key (keeper is the only client)
create policy "keeper_all_operations" on operations for all using (true) with check (true);
create policy "keeper_all_snapshots" on position_snapshots for all using (true) with check (true);
create policy "keeper_all_pending" on pending_actions for all using (true) with check (true);
