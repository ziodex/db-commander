CREATE TABLE public.customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text,
  balance numeric(24,8) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.customers (name, email, balance) VALUES
  ('Ada Lovelace', 'ada@example.test', 1250.50),
  ('Grace Hopper', 'grace@example.test', 908.75),
  ('Edsger Dijkstra', 'edsger@example.test', 340.00),
  ('Margaret Hamilton', 'margaret@example.test', 2140.125);
CREATE TABLE public.projects (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, customer_id bigint REFERENCES public.customers(id));
INSERT INTO public.projects (name, customer_id) VALUES ('Analytical Engine', 1), ('Compiler', 2), ('Apollo', 4);
CREATE VIEW public.customer_projects AS SELECT c.name AS customer, p.name AS project FROM public.customers c JOIN public.projects p ON p.customer_id=c.id;

-- Server browsing uses a non-superuser so denied databases are meaningful.
CREATE USER browser_user PASSWORD 'local-test-only';
GRANT CONNECT ON DATABASE dbcommander, postgres TO browser_user;
GRANT USAGE ON SCHEMA public TO browser_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO browser_user;
CREATE DATABASE "team's data" OWNER browser_user;
CREATE DATABASE private_database;
REVOKE CONNECT ON DATABASE private_database FROM PUBLIC;
\connect "team's data"
CREATE TABLE switch_marker(id integer PRIMARY KEY, label text);
INSERT INTO switch_marker VALUES (7, 'target database');
GRANT SELECT, INSERT, UPDATE, DELETE ON switch_marker TO browser_user;
