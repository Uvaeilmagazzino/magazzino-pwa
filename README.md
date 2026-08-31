# magazzino-pwa

Gestionale magazzino e lavorazioni basato su GitHub Pages + Supabase.

## Pubblicazione
Caricare tutti i file nella root del repository e attivare GitHub Pages da Settings → Pages → Deploy from a branch → main / root.

## Sicurezza
Nel file `config.js` è presente solo la Publishable Key di Supabase. Non inserire mai service_role, secret key, password database o password utenti nel repository.
