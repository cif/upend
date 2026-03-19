-- goodbyes: ways to say goodbye in many languages
CREATE TABLE public.goodbyes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  language    text NOT NULL,
  phrase      text NOT NULL,
  romanization text,            -- pronunciation hint for non-latin scripts
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- seed with a handful of examples
INSERT INTO public.goodbyes (language, phrase, romanization) VALUES
  ('English',    'Goodbye',       null),
  ('Spanish',    'Adiós',         null),
  ('French',     'Au revoir',     null),
  ('Japanese',   'さようなら',    'Sayōnara'),
  ('Mandarin',   '再见',          'Zàijiàn'),
  ('Arabic',     'مع السلامة',   'Ma''a as-salāma'),
  ('Swahili',    'Kwaheri',       null),
  ('Hawaiian',   'Aloha',         null),
  ('Russian',    'До свидания',   'Do svidaniya'),
  ('Italian',    'Arrivederci',   null);
