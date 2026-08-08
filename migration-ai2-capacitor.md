# Migration AI2 → Capacitor (même nom de package)

> Refaire une app publiée via MIT App Inventor avec Capacitor, en gardant le
> **même nom de package** pour conserver les users existants — et publier
> ensuite via API, sans jamais retourner dans la console Google Play.

Oui, le nom `appinventor.ai_xxx.appname` reste moche. Non, personne regarde.

---

## TL;DR

1. Récupère ton package name exact depuis l'export AI2
2. Active **Play App Signing** dans la Play Console
3. Crée un **service account** Google Cloud + lie-le à la Play Console
4. Configure Capacitor avec le **même `appId`**
5. Génère ton **keystore** (ta propre upload key)
6. Configure la signature Gradle
7. Build l'AAB
8. Installe **fastlane** et configure-le
9. Premier upload : `fastlane deploy`
10. Updates suivantes : bump version + `fastlane deploy`

---

## Prérequis

- [ ] **Node.js** ≥ 18 + npm
- [ ] **Java 17** (ou 21) — Gradle moderne
- [ ] **Android SDK** installé (via Android Studio)
- [ ] Accès **Owner** à ta Play Console
- [ ] Un projet **Google Cloud** (gratuit suffit)
- [ ] Ton projet **Capacitor** déjà fonctionnel (`npx cap add android` fait)

---

## Étape 1 — Récupère ton package name exact

Une typo ici et t'es mort. Va dans MIT App Inventor :

1. Ouvre ton projet
2. **Projects → Export selected project (.aia) to my computer**
3. Renomme le `.aia` en `.zip` et ouvre-le
4. Édite `youngandroidproject/project.properties`
5. Tu verras : `main=appinventor.ai_TON_USER.appname`

**Note ce `appinventor.ai_…` exactement.** C'est ton `appId` cible.

---

## Étape 2 — Play App Signing

Play App Signing permet à Google de gérer la clé de signature de l'app
tandis que toi tu gères uniquement la **upload key**. Sans ça, impossible de
passer de la clé MIT à ta clé.

1. **Play Console** → ton app
2. **Setup → App integrity**
3. Section **App signing** → **Enroll**
4. Choisis **"Use Google-generated key"** (le plus simple)
5. Suis les étapes. À la fin, Google génère un certificat d'app signing
   et te fournit un "keytool command" pour générer ton upload key — **garde
   cette commande pour l'étape 5**.

> Si l'app est déjà signée avec une clé que tu contrôles (pas le cas ici
> puisque c'est MIT qui signe), tu peux uploader l'ancien keystore.

---

## Étape 3 — Service account Google Cloud

C'est ce qui permet à fastlane de publier sans toi dans la console.

1. Va sur [Google Cloud Console](https://console.cloud.google.com/)
2. Crée un projet (ou prends un existant) lié à ton app
3. **IAM & Admin → Service Accounts → Create service account**
4. Nom au choix, ID au choix
5. Pas de rôle à donner ici — on le fera côté Play Console
6. **Done** → clique sur le SA créé → onglet **Keys** → **Add Key →
   Create new key → JSON**
7. Télécharge le JSON, stocke-le **hors du repo**
   (ex : `~/keys/play-store-sa.json`)

Maintenant lie-le à la Play Console :

1. **Play Console → Settings → API access**
2. Section "Service accounts" → **Link** ton service account
3. Une fois lié, **Grant access** à côté
4. Droits : **Release manager** (suffisant pour publier, pas pour toucher
   aux finances)

---

## Étape 4 — Configure ton projet Capacitor

Dans `capacitor.config.ts` :

```ts
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'appinventor.ai_TON_USER.appname', // ← ton package AI2 exact
  appName: 'Ton App',
  webDir: 'dist',
  // ... le reste de ta config
};

export default config;
```

Sync :

```bash
npx cap sync android
```

Vérifie aussi `android/app/build.gradle` :

```gradle
android {
  namespace "appinventor.ai_TON_USER.appname"
  defaultConfig {
    applicationId "appinventor.ai_TON_USER.appname"
    // ...
  }
}
```

---

## Étape 5 — Génère ton keystore (upload key)

⚠️ **Stocke ce fichier en lieu sûr, hors git, hors cloud public.**
Si tu le perds, tu ne peux plus jamais mettre à jour ton app.

```bash
keytool -genkey -v \
  -keystore ~/keys/upload.keystore \
  -alias upload \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

On te demande :
- Mot de passe du keystore (note-le !)
- Nom, organisation, etc. (peu importe)
- Mot de passe de la clé (souvent le même que le keystore)

**Backup ce `.keystore` + ses mots de passe** dans un endroit sûr
(coffre-fort, password manager, etc.).

> 💡 Si l'étape 2 t'a filé une commande `keytool` spécifique, utilise-la
> plutôt — elle garantit que la clé matche exactement ce qu'attend
> Play App Signing.

---

## Étape 6 — Configure la signature Gradle

Crée `android/key.properties` (à gitignore !) :

```properties
storeFile=/chemin/absolu/vers/upload.keystore
storePassword=TON_MOT_DE_PASSE_KEYSTORE
keyAlias=upload
keyPassword=TON_MOT_DE_PASSE_CLE
```

> Sur Windows, préfère les `C:/Users/...` (slashes) aux backslashes —
> Gradle les gère mieux.

Ajoute à `.gitignore` (à la racine ou dans `android/`) :

```
android/key.properties
**/upload.keystore
```

Modifie `android/app/build.gradle` pour charger ce fichier :

```gradle
import java.util.Properties
import java.io.FileInputStream

def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
  keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
  // ... ta config existante ...

  signingConfigs {
    release {
      keyAlias keystoreProperties['keyAlias']
      keyPassword keystoreProperties['keyPassword']
      storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
      storePassword keystoreProperties['storePassword']
    }
  }

  buildTypes {
    release {
      signingConfig signingConfigs.release
      minifyEnabled false
      // ... ta config release ...
    }
  }
}
```

---

## Étape 7 — Build l'AAB

```bash
cd android
./gradlew bundleRelease
```

Tu obtiens : `android/app/build/outputs/bundle/release/app-release.aab`

C'est cet AAB que tu vas uploader.

---

## Étape 8 — Installe fastlane

fastlane = l'outil qui parle à l'API Google Play proprement.

**Sur Windows** (le plus simple) :

1. Installe [RubyInstaller](https://rubyinstaller.org/) (version 3.x avec MSYS2)
2. Puis :

```bash
gem install fastlane
```

**Sur macOS** :

```bash
brew install fastlane
```

**Sur Linux** :

```bash
sudo apt install ruby-dev
gem install fastlane
```

---

## Étape 9 — Configure fastlane

```bash
cd android
fastlane init
```

- Pas de Fastfile existant → fastlane en crée un
- Choisis **"Manual setup"** (ou "Upload to Play Store" si proposé)

Édite `android/fastlane/Appfile` :

```ruby
json_key_file "/chemin/absolu/vers/play-store-sa.json"
package_name "appinventor.ai_TON_USER.appname"
```

Édite `android/fastlane/Fastfile` pour ajouter une lane `deploy` :

```ruby
default_platform(:android)

platform :android do
  desc "Deploy a new version to production"
  lane :deploy do
    upload_to_play_store(
      track: 'production',
      release_status: 'completed', # ou 'draft' pour review manuelle
      aab: 'app/build/outputs/bundle/release/app-release.aab',
    )
  end
end
```

---

## Étape 10 — Premier upload

```bash
cd android
fastlane deploy
```

fastlane :
1. Upload l'AAB
2. Le pousse sur le track "production" (ou en draft)
3. Te dit si tout est OK

⚠️ **Premier upload** : Play Console peut prendre quelques heures pour
valider le changement de signature. Sois patient.

Vérifie dans **Play Console → Release → Production** que l'AAB est listé.

---

## Étape 11 — Les updates suivantes

À chaque nouvelle version, dans `android/app/build.gradle` :

```gradle
defaultConfig {
  applicationId "appinventor.ai_TON_USER.appname"
  versionCode 2   // ← INCRÉMENTE à chaque upload
  versionName "1.1.0"
}
```

Puis :

```bash
npx cap sync android
cd android
./gradlew bundleRelease
fastlane deploy
```

C'est tout. **Zéro console Google à toucher.**

---

## Dépannage

### "Signature mismatch" à l'upload

Tu signes avec un keystore ≠ de celui attendu par Play App Signing.
Vérifie `key.properties` et que t'as bien linké la bonne clé
(Setup → App integrity → App signing).

### "Package name not found"

L'API ne trouve pas l'app. Vérifie :
- Que `applicationId` dans `build.gradle` correspond exactement
- Que le service account a accès à la bonne app
  (Play Console → Settings → API access)

### L'upload passe mais l'update n'est pas poussé

L'update est "staged" sur le track. Va dans Play Console → Release →
Production pour review et rollout manuel, OU change
`release_status: 'completed'` pour passer en auto-rollout.

### "You haven't accepted the play android developer distribution agreement"

Première fois avec l'API : va sur Play Console → Settings → API access,
accepte les termes. Faut le faire une fois.

### `keytool` introuvable (Windows)

Ajoute le dossier `bin` de ton JDK au PATH, ou utilise le chemin complet
`"C:\Program Files\Java\jdk-17\bin\keytool.exe"`.

### `gradlew` permission denied (Linux/macOS)

`chmod +x android/gradlew`

### Play Console te demande un "data safety form"

C'est dans la console, **pas faisable via API**. Une fois rempli, t'y
retouches plus jamais (sauf si les permissions de l'app changent).

---

## Cheat sheet

```bash
# Bump version dans android/app/build.gradle (versionCode + versionName)

# Sync Capacitor
npx cap sync android

# Build AAB
cd android && ./gradlew bundleRelease

# Deploy en production
fastlane deploy

# Rollout progressif (10% des users)
# Édite Fastfile :
#   upload_to_play_store(track: 'production', rollout: '0.1', ...)

# Halt un rollout en cours
fastlane run upload_to_play_store track:'production' track_changes:'halt'
```

---

## Bonus : si un jour tu veux un nom propre

Quand tu seras prêt à migrer vers un package name propre
(ex : `ch.upstride.app`), c'est simple :
- Nouvelle fiche Play Store
- fastlane pointe vers le nouveau package
- Migration users via une bannière dans l'ancienne app

Mais pour l'instant, `appinventor.ai_…` fait le job.
