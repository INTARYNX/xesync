# XEsync — Des améliorations simples pour donner envie de revenir

> Proposition produit — 10 septembre 2026. Idées à tester, pas fonctionnalités déjà disponibles.

## Le cap

Faire de XEsync le compagnon qu’on ouvre à chaque séance : il donne un petit objectif, reconnaît les progrès et laisse une bonne raison de revenir.

Les encouragements et les mini-défis sont un bon premier axe. Ils utilisent les données déjà reçues du rameur et peuvent fonctionner sans connexion Internet. Leur valeur vient du bon moment et de la pertinence du message, davantage que du nombre de messages.

**Principe demandé : on ouvre l’app, on rame et l’app stimule automatiquement selon l’effort observé. Aucune saisie, aucun objectif à configurer, aucune activation des défis avant la séance.** Les encouragements et les défis sont actifs par défaut. Une option discrète permet de les couper, sans devenir une étape du parcours.

**Premier lot conseillé : des jalons automatiques, des encouragements contextuels, des défis adaptés à la cadence du moment et un bilan calculé.** Pas besoin d’IA générative pour cette version : quelques règles explicables et de bons textes suffisent.

Ces propositions partent du code local : mesures FTMS en direct, détection de pause, scène animée, sauvegarde et connexion au compte. Elles ne constituent pas une étude de marché ni une promesse de rétention.

## Les priorités

### Analyse revue : rendre la séance libre stimulante

Le produit doit accompagner une séance libre qui devient intéressante au fil des coups de rame. Le parcours principal n’est pas une série d’exercices à sélectionner puis à suivre. Sa promesse : **« Tu rames. XEsync trouve de quoi te donner envie de continuer. »**

La boucle recherchée est simple : observer l’effort spontané, choisir un petit moment de stimulation pertinent, rendre sa progression visible, reconnaître ce qui a réellement été accompli, puis laisser respirer la séance. L’absence de réponse à une proposition ne doit pas être interprétée comme un échec ni un manque de motivation.

**Un défi de régularité répété ne suffira probablement pas à rendre l’app amusante.** C’est un premier mécanisme facile à vérifier, pas toute l’expérience. La variété doit venir de plusieurs moments :

| Moment | Exemple | Condition de pertinence |
| --- | --- | --- |
| Anticipation | « Encore 80 m pour passer le kilomètre » | Un repère réel est proche, sans compte à rebours imposé |
| Petit défi de maintien | « Garde ce rythme pendant 20 secondes » | L’effort récent est stable ; la cible vient des mesures du moment |
| Progression personnelle | « Cette portion est ta plus rapide de la séance » | La portion est terminée et comparable aux précédentes ; pas de conclusion sur un échantillon isolé |
| Célébration | Un repère franchi dans la scène et un bref message | Une réussite a réellement eu lieu, sans masquer les mesures |
| Temps calme | Retour à la scène et aux mesures seules | Après une sollicitation, pendant un ralentissement ou lorsque les propositions ne sont pas suivies |

La scène animée peut donner une forme visible aux petits objectifs : un repère qui approche, une ligne franchie, une courte animation de réussite. Préférer d’abord une surcouche légère liée à la progression mesurée. Une intégration profonde dans la scène 3D est une évolution à chiffrer séparément. La scène ne doit pas avancer artificiellement pour faire croire à une réussite.

Les délais et tolérances indiqués plus bas sont des **hypothèses de départ**, pas les fondations du produit. Un chronomètre peut interdire des sollicitations trop rapprochées ; son expiration ne suffit jamais à déclencher un défi. Il faut aussi une période de mesures exploitables, un effort compatible et aucun événement prioritaire. La durée de maintien de 30 secondes décrite plus bas est la première variante spécifiée ; d’autres durées courtes restent à tester.

Le bilan termine cette boucle : tableau calculé inspiré de la photo, puis un fait marquant vérifiable — portion la plus rapide, cadence la plus régulière ou simplement distance parcourue. Aucun record ou compliment quantifié ne doit être inventé pour remplir l’écran.

Pour les premiers essais, évaluer surtout si les propositions arrivent au bon moment, si leur variété plaît et si les personnes souhaitent retrouver cette expérience à la séance suivante. L’allongement de l’effort n’est pas une preuve suffisante de qualité.

L’effort est relatif : **petit** = ajout ciblé dans l’interface ou les règles locales ; **moyen** = nouvel état à conserver et plusieurs parcours à tester. Les fonctionnalités fondées sur l’historique demandent de vérifier les données réellement accessibles dans l’app et son écran d’accueil intégré.

| Ordre | Amélioration | Bénéfice recherché | Effort | Dépendance principale |
| --- | --- | --- | --- | --- |
| 1 | Encouragements liés à un événement réel | Se sentir accompagné pendant l’effort | Petit | Mesures et état de séance |
| 2 | Prochain jalon automatique | Avoir un petit repère motivant sans rien décider | Petit | Distance, temps actif et progression |
| 3 | Un mini-défi de régularité | Introduire un moment de jeu sans demander d’accélérer | Moyen | Mesures fraîches, chronomètre, états du défi |
| 4 | Bilan gratifiant et tableau de portions calculées | Comprendre son effort et sa régularité | Moyen | Résumé, échantillons et bornes fiables avant remise à zéro |
| 5 | Accompagnement qui se recalibre à chaque séance | Recevoir des défis adaptés sans rien configurer | Moyen | Effort récent et préférences mémorisées |
| 6 | Progrès hebdomadaires automatiques | Donner envie de revenir sans culpabiliser | Moyen | Historique et dates fiables |
| 7 | Meilleures marques personnelles | Rendre les progrès visibles | Moyen | Séances comparables et complètes |
| 8 | Carte de séance à partager | Permettre de montrer une réussite | Moyen | Génération d’image et partage natif |

La confiance reste un préalable : sauvegarde visible, reconnexion compréhensible et mesures cohérentes. Un défi agréable ne compense pas une séance perdue.

## 1. Des encouragements qui ont une raison d’apparaître

Un court message, deux lignes maximum, dans une zone fixe qui ne masque ni l’allure ni la distance. Aucun bouton à toucher pendant l’effort.

### Premier catalogue

| Déclencheur | Exemple de message | Règle |
| --- | --- | --- |
| Premier effort confirmé | « C’est parti. Trouve ton rythme. » | Une fois par séance |
| Premier kilomètre | « 1 km dans les jambes ! » | Au franchissement, jamais à chaque paquet |
| Approche d’un jalon | « Le kilomètre approche : encore 100 m ! » | Selon la distance réelle, sans instruction d’accélérer |
| Durée franchie | « Déjà 5 minutes de rame ! » | Uniquement après le seuil réel de temps actif |
| Reprise après une pause | « On reprend à ton rythme. » | Après reprise confirmée, pas sur une simple reconnexion |
| Défi réussi | « 30 secondes de cadence régulière. Bien joué. » | Seulement après validation réelle |
| Jalon atteint | « 2 km parcourus. Bien joué ! » | L’utilisateur continue librement à ramer |

Les exemples sont en français. L’interface actuelle étant en anglais, prévoir un catalogue FR/EN cohérent, plutôt qu’un mélange de langues à l’écran.

### Ce qui évite l’effet pénible

- Affichage pendant environ 4 secondes ; au moins 60 secondes entre deux encouragements ordinaires. Valeurs initiales à tester.
- Un seul message à la fois. Priorité au résultat d’un défi, puis à un jalon atteint, puis aux encouragements ordinaires.
- Pas de file d’attente de compliments : un message devenu tardif est abandonné.
- Pas de messages ordinaires pendant un défi, une pause, une reconnexion ou une sauvegarde.
- Aucun « accélère ! » automatique quand la cadence baisse : la personne peut volontairement récupérer.
- Encouragements et défis automatiques par défaut, sans son (mode **Coaching**). Une commande discrète bascule vers **Just Row** — le même mode calme, renommé pour se lire comme un vrai choix plutôt qu’un réglage caché — qui coupe encouragements, jalons et défis ; mémoriser ce choix par compte, sans écran de sélection ni confirmation avant chaque séance.
- Pas de commentaire sur la technique du geste ou l’état physique : les données disponibles ne permettent pas de les évaluer.

## 2. Des petits repères sans rien saisir

La séance démarre sur les premiers coups de rame, sans écran de choix de programme, de durée, de distance ou de difficulté. L’app observe le mouvement et fait apparaître un prochain repère quand il devient proche : « Encore 100 m avant 1 km », par exemple.

Pendant l’effort, afficher une seule progression secondaire, en plus des mesures habituelles. Les jalons sont des seuils simples de distance ou de temps actif ; leur proximité et la fréquence des messages déterminent s’ils méritent d’être annoncés. Ne pas assigner une durée totale supposée à la personne.

Au franchissement : courte célébration, puis retour aux mesures. Ne jamais terminer ou sauvegarder automatiquement parce qu’un jalon a été atteint, ni repousser immédiatement la cible avec un « encore plus ! ».

**Critère de réussite :** une personne qui ne touche à aucun réglage reçoit une stimulation pertinente dès sa première séance, et peut arrêter quand elle le souhaite.

## 3. Des mini-défis durant l’effort

### Le premier à construire : « Cadence régulière »

L’idée : réussir un petit exercice d’attention, sans devoir augmenter l’intensité.

| Étape | Comportement proposé |
| --- | --- |
| Activation | Automatique par défaut dès que la séance et les mesures le permettent ; aucune action demandée |
| Éligibilité | Au moins 2 minutes actives, avec 30 secondes récentes de mesures exploitables et sans interruption |
| Référence | Médiane des coups/minute de ces 30 secondes, arrondie ; éviter de partir d’une mesure isolée |
| Annonce | « Mini-défi dans 5 s : garde ta cadence pendant 30 s » |
| Consigne | Par exemple « Entre 22 et 26 coups/min », si la référence est 24 |
| Pendant | Compte à rebours et repère discret indiquant si la cadence est dans la plage |
| Réussite | Au moins 24 secondes sur 30 dans la plage, avec des données valides |
| Fin | « Défi réussi : cadence régulière ! » ou « Défi terminé. Continue à ton rythme. » |

Les durées et tolérances sont des paramètres de départ à ajuster avec les premiers utilisateurs. Mesurer le **temps** dans la plage, pas le pourcentage de paquets Bluetooth : leur fréquence peut varier.

Les défis se lancent sans bouton « accepter », sans saisie et sans interaction pendant l’effort. La personne participe simplement en ramant ; si elle suit son propre rythme, aucune pénalité ni relance insistante.

### Adapter la stimulation à ce qui se passe maintenant

L’app se base sur la cadence, les watts, les variations de distance, le temps actif et la fraîcheur des données. Elle reconnaît des tendances de mesure, sans prétendre connaître la fatigue ni la capacité maximale de la personne. Aucun âge, niveau sportif, objectif ou capteur cardiaque requis.

| Situation observée | Réponse automatique |
| --- | --- |
| Début de séance, pas encore de référence | Message de départ, observation ; aucun défi immédiat |
| Cadence et puissance relativement stables | Défi de régularité autour de la cadence réellement tenue |
| Effort qui augmente de lui-même | Reconnaître la progression ; attendre un nouveau plateau avant de proposer un défi |
| Baisse durable de cadence ou de puissance | Espacer les sollicitations ; ne pas demander de rejoindre l’ancienne cible |
| Effort très variable | Préférer un jalon de distance à un défi de maintien |
| Reprise après pause | Message de reprise, puis nouvelle période d’observation |
| Défi réussi | Féliciter, laisser un temps calme ; varier ensuite sans augmenter systématiquement l’intensité |
| Défi non suivi | Fin neutre, sollicitations plus espacées ; l’absence de participation n’est pas un échec de séance |

Premières règles proposées, à tester : référence sur 30 secondes de données fraîches ; premier défi après au moins 2 minutes actives ; au moins 3 minutes actives sans défi entre deux propositions. Après un défi non suivi, attendre au moins 5 minutes ; après deux consécutifs, garder seulement les jalons et encouragements pour le reste de la séance. Une séance longue peut donc recevoir plusieurs petits défis, sans devenir une succession de sollicitations.

Comparer deux fenêtres récentes pour reconnaître une tendance persistante, et non deux paquets isolés. Comme point de départ, une baisse d’au moins 10 % de puissance moyenne ou 2 coups/min entre deux fenêtres de 15 secondes suspend les nouvelles propositions jusqu’à stabilisation. Ce sont des paramètres d’interface à ajuster aux mesures réelles, pas des seuils physiologiques.

Recalculer la référence avant chaque défi. Pendant ses 30 secondes, garder la cible fixe pour que la réussite ait un sens ; si une baisse durable ou une interruption est détectée, terminer le défi de façon neutre puis se recalibrer. Ne pas déplacer discrètement la cible en plein défi.

Exemple : une cadence stable à 18 coups/min produit une plage de 16–20 ; une cadence stable à 28 produit 26–30. Si la personne ralentit ensuite, le prochain défi repart de sa nouvelle cadence. La stimulation s’adapte à son effort, sans lui imposer celui de quelqu’un d’autre ou celui d’hier.

### Deux variantes à ajouter ensuite

- **Le prochain repère :** « Plus que 100 m avant le prochain kilomètre ». Pas de limite de temps, aucune obligation de finir. Réutilise les jalons existants.
- **Ton allure régulière :** maintenir une allure proche de celle spontanément observée, sans valeur à saisir. À différer : l’allure affichée est actuellement lissée sur 30 secondes, ce qui rendrait un défi court lent à réagir. Il faut d’abord définir une mesure adaptée.

Éviter dans cette première version les sprints surprises, les objectifs imposés en watts et les défis de fréquence cardiaque. La régularité fournit déjà une expérience de jeu avec moins de paramètres à gérer.

### Un troisième type, à envisager pour le tableau de fin de séance : le défi de distance

En pleine séance libre, l’app peut proposer un segment ciblé à parcourir, du type « On fait un 3 000 m » — sans écran de préparation, comme les autres défis. La cible se choisit selon l’effort déjà fourni et le temps restant probable de la séance : **3 000 m est envisagé comme plafond haut, la plupart des propositions devraient rester nettement plus courtes**. Aucune distance totale n’est jamais imposée à la personne ; le segment reste une proposition parmi d’autres, pas un objectif de séance.

**Le but reste la variété** : ce défi de distance est un type de stimulation parmi d’autres (jalon, défi de cadence, célébration, temps calme), pas un mécanisme systématique qui remplacerait les autres. Une séance ne doit pas devenir une suite répétitive de « fais un X m » ; la cadence et le choix du type de sollicitation suivent les mêmes règles d’espacement et d’adaptation au contexte que le reste de la section 3.

Le segment complété (distance réellement parcourue entre le lancement et la fin du défi) devient naturellement une ligne du tableau de fin de séance (section 4), sur le modèle des fractions du PM5 : le tableau reflète alors la structure effective de la séance plutôt qu’un découpage temporel arbitraire.

### Cas à traiter dès le départ

- Pause ou perte Bluetooth : interrompre le défi sans le compter comme un échec ; ne pas reprendre son compte à rebours silencieusement.
- Données trop anciennes : ne plus accumuler de secondes réussies. Distinguer une mesure valide hors plage d’une absence de données.
- Aucun paquet frais pendant plus de 2 secondes : proposition initiale d’annulation neutre, à ajuster à la cadence réelle des notifications du rameur.
- Jalon atteint pendant un défi : ne pas superposer deux messages ; le résultat du défi reste prioritaire.
- Nouvelle séance : effacer les compteurs et références du défi précédent.
- Pas d’échauffement supposé à partir du seul chronomètre : les 2 minutes sont un délai d’interface, pas une évaluation de la préparation physique.

## 4. Un bilan qui donne envie de recommencer

L’écran de fin actuel confirme surtout l’enregistrement. Ajouter automatiquement une petite synthèse directement visible : durée, distance, jalons franchis et défis éventuellement réussis.

Exemple :

> **Ton kilomètre est terminé.** 1 000 m en 5:42.
>
> Mini-défi réussi : 30 secondes de cadence régulière.
>
> Séance enregistrée sur ton téléphone — synchronisation en attente.

Séparer clairement la réussite sportive de l’état de sauvegarde. Ne pas afficher « synchronisé » tant que le serveur ne l’a pas confirmé.

Proposer **Ramer à nouveau** et **Voir mes séances**. Valoriser une chose vraie plutôt que cumuler des badges. Si aucun défi n’a été réussi, la distance ou la durée suffit : aucune tâche n’était imposée.

Point d’intégration : conserver une copie du résumé final avant la remise à zéro du suivi FTMS. Il servira au bilan sans dépendre de l’accès Internet.

### Exigence ajoutée : le tableau de fin de workout

**L’app doit pouvoir afficher, à la fin de chaque séance, un tableau calculé à partir des mesures enregistrées**, inspiré de la photo fournie : date de l’effort, une ligne de total, puis le détail par portions avec temps, mètres, allure sur 500 m, cadence et fréquence cardiaque.

Il ne s’agit ni d’une image statique ni de valeurs de démonstration. Le calcul doit fonctionner hors ligne et le détail doit pouvoir être retrouvé après sauvegarde. L’affichage fait partie du bilan, avec accès au détail sans passer obligatoirement par l’écran d’historique distant.

#### Présentation

Exemple illustratif cohérent, distinct des valeurs de la photo : une séance de 60 minutes découpée en cinq portions de 12 minutes.

| Temps cumulé | Distance de la portion | Allure /500 m | Coups/min | FC moyenne |
| --- | ---: | ---: | ---: | ---: |
| **Total · 1:00:00** | **12 000 m** | **2:30.0** | **18** | **132** |
| 12:00 | 2 500 m | 2:24.0 | 18 | 130 |
| 24:00 | 2 400 m | 2:30.0 | 18 | 132 |
| 36:00 | 2 350 m | 2:33.2 | 18 | 134 |
| 48:00 | 2 400 m | 2:30.0 | 18 | 132 |
| 1:00:00 | 2 350 m | 2:33.2 | 18 | 132 |

Le temps des lignes de détail est **cumulé**, tandis que leur distance est celle de la **portion**, comme dans la référence. Afficher « Portions de 12 min » pour éviter toute ambiguïté. La première ligne utilise les totaux de toute la séance.

Le total reste visuellement distinct. Sur téléphone, conserver les cinq colonnes lisibles, avec des unités courtes et une légende ; ne pas ajouter de graphique obligatoire pour comprendre le tableau.

#### Découpage proposé

- Par défaut : **une ligne par jalon réellement franchi ou par segment de stimulation proposé par l’app** (par exemple un jalon « 1 km », ou un segment annoncé du type « fais un 3 000 m »). Le tableau reflète ainsi la structure effective de la séance, comme le fait le PM5 pour un entraînement programmé (`6x500m`), sans que XEsync ait besoin d’un entraînement préconfiguré : les lignes viennent des jalons observés pendant l’effort, pas d’une saisie préalable.
- Les mini-défis courts (par exemple 30 secondes de cadence régulière) ne créent pas leur propre ligne : ils apparaissent en note ou en badge sur la ligne du jalon pendant laquelle ils ont eu lieu, pour garder des lignes de granularité comparable.
- Si les jalons annoncés pendant l’effort sont trop rapprochés pour rester lisibles en tableau, regrouper plusieurs jalons consécutifs dans une seule ligne, ou définir une cadence de jalon dédiée à l’affichage du tableau, distincte de la fréquence des messages pendant l’effort. Point à calibrer avec les premiers tableaux réels.
- Si une séance ne comporte aucun jalon exploitable (aucune distance franchie, séance trop courte ou jalons trop irréguliers pour un découpage lisible), retomber sur le découpage par défaut initial : **cinq portions de même durée active**. Ainsi, 60 minutes donnent cinq fois 12 minutes ; 20 minutes donnent cinq fois 4 minutes.
- Utiliser la durée et la distance réellement effectuées, jamais une durée ou un segment prévu à l’avance. Ne pas inventer de portions futures.
- Si une séance est trop courte pour fournir de découpage exploitable même en repli, réduire le nombre de portions, voire afficher seulement le total.
- Évolution possible après la séance uniquement : vue alternative par portions fixes de 500 m, 1 km ou 5 minutes. Une dernière portion incomplète reste affichée avec sa durée et sa distance réelles. Le tableau par défaut ne nécessite aucun choix.

#### Formules à appliquer

Pour une portion allant du temps actif `a` au temps actif `b`, avec les compteurs cumulés corrigés `D(t)` en mètres et `C(t)` en coups :

```text
durée de la portion (s) = b − a
distance de la portion (m) = D(b) − D(a)
coups de la portion = C(b) − C(a)
allure moyenne (s / 500 m) = 500 × durée / distance
cadence moyenne (coups/min) = 60 × coups / durée
FC moyenne (bpm) = somme(FC valide × durée couverte) / somme(durées couvertes)
```

- Appliquer les mêmes formules à l’ensemble de la séance pour la ligne de total. **Ne pas calculer l’allure globale par une moyenne des allures des portions**, ni par la moyenne de l’allure glissante affichée pendant l’effort.
- Cadence : utiliser les deltas du compteur de coups, plutôt qu’une moyenne non pondérée des valeurs instantanées. Des coups fractionnaires estimés aux bornes peuvent exister lors de l’interpolation ; arrondir uniquement le résultat affiché.
- Fréquence cardiaque : pondérer par le temps réellement couvert, car les paquets ne sont pas régulièrement espacés. Une valeur absente, notamment la sentinelle FTMS `255`, n’est jamais un zéro à inclure dans la moyenne.
- Proposition initiale : afficher une FC numérique seulement si au moins 80 % de la portion est couverte par des mesures valides ; sinon afficher `—`. Ce seuil est une règle de qualité à valider, pas un critère médical.
- Distance nulle ou durée nulle : afficher `—` pour toute moyenne dont le dénominateur est nul, jamais `Infinity` ou `NaN`.
- Garder toute la précision pendant le calcul ; arrondir à l’affichage : mètres entiers, cadence et FC entières, allure au dixième de seconde.

#### Données nécessaires et limites du suivi actuel

Le format compact actuel contient déjà `[temps actif, distance cumulée, coups cumulés, cadence, watts, FC, allure glissante]`. C’est une base utile, mais **les moyennes actuelles du résumé ne suffisent pas à produire ce tableau correctement**.

À prévoir dans l’implémentation :

1. Figer les mesures et le résumé avant la remise à zéro de la séance. Conserver une borne initiale et une borne finale fiables, même si l’espacement minimal entre échantillons aurait normalement empêché leur enregistrement.
2. Utiliser une même définition du temps actif pour le tableau, la durée totale et les pauses. Le délai actuel de détection d’inactivité doit être traité de manière cohérente ; ne pas présenter le temps comme strictement limité aux coups de rame.
3. Interpoler distance et coups à une borne située entre deux mesures proches, avec les horodatages réels. Employer les mêmes bornes interpolées pour les deux portions adjacentes afin de conserver les totaux.
4. Ne pas interpoler à travers une pause, une perte Bluetooth ou un long trou de mesures. Enregistrer ces interruptions et la fraîcheur des données ; les seuls temps actifs compressés ne permettent pas toujours de les reconstituer après coup.
5. Pour la FC, limiter la durée couverte par une mesure à l'arrivée de la suivante ou au seuil de fraîcheur retenu. Une valeur ancienne ne doit pas couvrir toute une déconnexion.
6. Si les compteurs cumulés permettent de retrouver le total après une coupure mais pas sa répartition entre portions, conserver le total et marquer les portions affectées « données insuffisantes ». Ne pas répartir artificiellement la distance de la coupure.
7. Utiliser les compteurs corrigés des remises à zéro du rameur. Une remise à zéro ne doit produire ni mètres négatifs ni double comptage.
8. Enregistrer la date réelle de début d’effort, distincte de la date d’envoi au serveur, et les informations nécessaires pour reproduire le tableau. Versionner les règles de calcul pour conserver un résultat cohérent après mise à jour.

Les anciennes séances peuvent avoir des informations manquantes, notamment sur les interruptions et la dernière borne. Ne pas inventer leur détail : afficher uniquement les mesures calculables, avec une indication de couverture incomplète si nécessaire.

Les distances arrondies des portions peuvent différer du total affiché d’un ou deux mètres. Les calculs doivent se réconcilier avant arrondi ; si nécessaire, indiquer « écarts possibles dus aux arrondis » plutôt que modifier les valeurs pour imiter la photo.

#### Critères d’acceptation

- Le tableau est disponible en fin de séance sans réseau, avec ou sans capteur cardiaque.
- Une séance synthétique de 60 minutes à vitesse constante totalisant 12 000 m donne cinq portions de 2 400 m et une allure de 2:30.0 partout.
- L’exemple variable ci-dessus donne une allure globale de 2:30.0, calculée sur les totaux, malgré les allures différentes des portions.
- Avant arrondi, la somme des durées, distances et coups des portions complètes correspond aux totaux sur la même couverture.
- Les pauses, bornes entre deux échantillons, derniers échantillons rapprochés, absences de FC, pertes Bluetooth et remises à zéro font l’objet de tests dédiés.
- Le même enregistrement et la même version de calcul produisent le même tableau immédiatement après l’effort et après réouverture.
- L’état de sauvegarde reste distinct : un tableau calculé n’est pas une preuve que la séance a été synchronisée.

## 5. Donner une raison de revenir

### Reprendre sans tout reconfigurer

À chaque retour, démarrer sans configuration et recalibrer l’accompagnement sur l’effort du jour. L’historique peut varier les messages, mais ne doit pas imposer les performances précédentes. Conserver seulement les préférences explicites comme le mode calme, par compte, avec un profil invité séparé sur les appareils partagés.

### Une semaine réussie, sans série punitive

Afficher automatiquement les faits de la semaine : « Déjà 2 séances cette semaine », « 5 km parcourus cette semaine ». Aucune fréquence à configurer et aucun engagement supposé. Une comparaison avec la semaine précédente n’apparaît que si les données le permettent.

Ne pas remettre symboliquement tous les progrès à zéro après un jour manqué. Éviter les notifications de culpabilisation ; une éventuelle invitation à revenir doit être facultative.

Cette fonctionnalité vient après la fiabilité de l’historique : utiliser la date réelle de l’effort, y compris quand une séance hors ligne est envoyée plusieurs jours après, et définir la semaine dans le fuseau de l’utilisateur.

### Des comparaisons avec soi-même

Commencer par « ta plus longue séance » ou « ta plus grande distance ». Pour un record sur 1 km, il faudra mesurer précisément le franchissement des 1 000 m ; la moyenne globale d’une séance plus longue ne constitue pas un temps sur 1 km.

Ne déclarer un record que si l’historique nécessaire est connu et les mesures sont comparables. Sinon écrire « meilleure marque sur cet appareil », ou ne rien annoncer.

## 6. Partage simple, après la séance

Une carte sobre : distance, durée, jalon ou défi réussi et visuel de rame. Prévisualisation puis partage explicitement déclenché par la personne.

Ne pas inclure automatiquement le nom, la fréquence cardiaque ou des informations de compte. La scène existante peut donner une identité visuelle à la carte, mais son export demande une vérification technique : ce n’est pas forcément le plus petit chantier.

## Une première livraison volontairement limitée

### Lot 1 — Accompagner et conclure

- Démarrage sans configuration ; prochains jalons automatiques.
- Catalogue d’une dizaine de messages déclenchés par des événements.
- Accompagnement activé par défaut ; commande discrète pour passer en mode calme.
- Bilan avec réussites observées, état réel de sauvegarde et tableau calculé : total + portions, temps, distance, allure, cadence et fréquence cardiaque.

### Lot 2 — Un moment de jeu

- Défis activés automatiquement, sans écran de préparation.
- Un premier type de défi : cadence régulière, recalibré avant chaque proposition et répété seulement si le contexte s’y prête.
- Compte à rebours lisible, réussite mesurée en temps et interruption propre.
- Résultat dans le bilan, sans changer les règles de sauvegarde de la séance.

### Lot 3 — Construire l’habitude

- Recalibrage automatique à chaque nouvelle séance.
- Progrès hebdomadaires calculés automatiquement.
- Meilleures marques personnelles quand l’historique le permet.

Reporter classement mondial, réseau social, coach conversationnel et catalogue de programmes. Ils demandent davantage de données, de contenu et de maintenance que les premiers ajouts proposés ici.

## Repères pour l’implémentation

Créer un petit module de règles d’accompagnement séparé de l’affichage et de la sauvegarde. Il reçoit des mesures et événements de séance, et produit des événements comme « jalon atteint », « défi commencé », « défi interrompu ».

- `ftms_integration.js` reste responsable des mesures, des pauses et des compteurs de séance.
- `controller.js` transmet les événements et coordonne l’accompagnement.
- `view.js` et les styles affichent les messages et la progression.
- Le catalogue de textes reste séparé des conditions de déclenchement pour faciliter la traduction.
- Les règles du premier lot fonctionnent localement, sans appel réseau pendant l’effort.

Éviter de construire ces règles à partir des textes visibles dans le DOM ou de la simple présence d’un ancien paquet. La fraîcheur des mesures et les événements de pause doivent être explicites.

Tests prioritaires : séance sans aucun réglage, défi adapté à deux cadences différentes, ralentissement durable, défis ignorés et espacement des propositions, mode calme mémorisé, seuil franchi une seule fois, fréquence variable des paquets, pause au milieu du défi, reconnexion, compteurs du rameur remis à zéro, jalon atteint pendant un défi et début d’une nouvelle séance.

## Comment savoir si cela apporte vraiment quelque chose ?

Premier essai proposé avec quelques utilisateurs : une séance libre, puis une séance avec accompagnement. Demander « À quel moment le message t’a aidé ? », « T’a-t-il gêné pour lire les mesures ? » et « Garderais-tu ce mode activé ? ».

Observer ensuite, avec un suivi d’usage minimal et annoncé :

| Question | Indicateur possible |
| --- | --- |
| L’accompagnement est-il souhaité ? | Mode conservé ou désactivé après essai |
| Les sollicitations tombent-elles au bon moment ? | Retours des utilisateurs et part des défis non suivis, sans assimiler cela à un manque d’effort |
| Le défi fonctionne-t-il correctement ? | Défis lancés, réussis et interrompus techniquement, comptés séparément |
| Donne-t-on envie de revenir ? | Retour dans les 7 jours suivant une première séance accompagnée, comparé à une période de référence |
| Le démarrage reste-t-il simple ? | Temps entre ouverture de l’app et première mesure active, avec causes de blocage observées |

Ne pas prendre l’allongement systématique des séances comme objectif. Le résultat recherché est une expérience appréciée, une progression compréhensible et l’envie de revenir. Une variation de ces indicateurs seule ne prouve pas que les messages en sont la cause.

**Décision produit : ramer suffit. L’app observe, stimule au bon moment, s’adapte et calcule le bilan. Commencer avec un seul type de défi, puis enrichir la variété selon les retours.**
