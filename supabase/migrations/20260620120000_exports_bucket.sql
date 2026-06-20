-- Private storage bucket for on-demand meal CSV exports. Files are written and
-- read only via the service-role client, and handed to users as short-lived
-- signed URLs, so no public access or extra storage policies are required.
insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;
