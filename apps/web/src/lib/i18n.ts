'use client';

import { createContext, useContext } from 'react';
import type { UiLocale } from '@eyesonbug/shared';

/**
 * A deliberately small i18n layer for M0.
 *
 * The point at this stage is that no user-facing string is hardcoded in a
 * component, so adding a locale is a data change rather than a refactor. This
 * is the language of the *interface*, which has nothing to do with the `locale`
 * dimension a test ran under — conflating the two is an easy mistake and an
 * expensive one to unpick later.
 */
const dictionaries = {
  en: {
    'app.name': 'EyesOnBug',
    'app.tagline': 'Acceptance test orchestration and reporting',
    'nav.projects': 'Projects',
    'nav.signOut': 'Sign out',
    'nav.theme': 'Toggle theme',
    'nav.language': 'Language',
    'login.title': 'Sign in',
    'login.github': 'Continue with GitHub',
    'login.devTitle': 'Development sign-in',
    'login.devHint': 'Seeded accounts, available because ALLOW_DEV_LOGIN is on.',
    'login.signIn': 'Sign in',
    'login.failed': 'Sign-in failed',
    'projects.title': 'Projects',
    'projects.empty.title': 'No projects yet',
    'projects.empty.body': 'A project groups the runs coming from one repository.',
    'projects.role': 'Your role',
    'project.overview': 'Overview',
    'project.repository': 'Repository',
    'project.defaultBranch': 'Default branch',
    'project.environments': 'Environments',
    'project.members': 'Members',
    'project.tokens': 'Ingest tokens',
    'project.tokens.hidden': 'Only project admins can view ingest tokens.',
    'project.capabilities': 'What you can do here',
    'project.viewRuns': 'View run history',
    'project.noRuns.title': 'No runs yet',
    'project.noRuns.body': 'Add the reporter to your workflow to start streaming results.',
    'common.loading': 'Loading',
    'common.error': 'Something went wrong',
    'common.retry': 'Try again',
    'common.production': 'Production',
    'common.never': 'Never',
    'runs.title': 'Runs',
    'runs.empty.title': 'No runs yet',
    'runs.empty.body': 'Add the reporter to your workflow and upload a report to see runs here.',
    'runs.noCommitMessage': 'No commit message',
    'run.title': 'Run',
    'run.total': 'total',
    'run.failureClusters': 'Failures, grouped by cause',
    'run.noFailures.title': 'Nothing failed',
    'run.noFailures.body': 'Every test in this run passed or was skipped.',
    'run.allTests': 'All tests',
    'cluster.failure': 'failure',
    'cluster.failures': 'failures',
    'cluster.test': 'test',
    'cluster.tests': 'tests',
    'result.history': 'Recent history',
    'result.error': 'Error',
    'result.screenshot': 'Screenshot',
    'result.artifacts': 'Artifacts',
    'result.retry': 'retry',
    'status.passed': 'passed',
    'status.failed': 'failed',
    'status.flaky': 'flaky',
    'status.skipped': 'skipped',
    'common.close': 'Close',
    'live.running': 'Running',
    'live.reconnecting': 'Reconnecting…',
    'live.eta': 'about',
    'live.cancel': 'Cancel',
    'live.cancelHint':
      'Marks the run cancelled and tells the reporter to stop. Stopping the GitHub Actions job itself needs the GitHub App.',
    'live.lanes': 'Configurations',
    'live.failuresSoFar': 'Failures so far',
    'live.recent': 'Recent results',
    'live.waiting': 'Waiting for the first results…',
  },
  fr: {
    'app.name': 'EyesOnBug',
    'app.tagline': "Orchestration et reporting des tests d'acceptation",
    'nav.projects': 'Projets',
    'nav.signOut': 'Se déconnecter',
    'nav.theme': 'Changer de thème',
    'nav.language': 'Langue',
    'login.title': 'Connexion',
    'login.github': 'Continuer avec GitHub',
    'login.devTitle': 'Connexion de développement',
    'login.devHint': 'Comptes de démonstration, disponibles car ALLOW_DEV_LOGIN est activé.',
    'login.signIn': 'Se connecter',
    'login.failed': 'Échec de la connexion',
    'projects.title': 'Projets',
    'projects.empty.title': 'Aucun projet',
    'projects.empty.body': "Un projet regroupe les exécutions d'un dépôt.",
    'projects.role': 'Votre rôle',
    'project.overview': "Vue d'ensemble",
    'project.repository': 'Dépôt',
    'project.defaultBranch': 'Branche par défaut',
    'project.environments': 'Environnements',
    'project.members': 'Membres',
    'project.tokens': "Jetons d'ingestion",
    'project.tokens.hidden': "Seuls les administrateurs peuvent voir les jetons d'ingestion.",
    'project.capabilities': 'Ce que vous pouvez faire ici',
    'project.viewRuns': "Voir l'historique",
    'project.noRuns.title': 'Aucune exécution',
    'project.noRuns.body':
      'Ajoutez le reporter à votre workflow pour commencer à envoyer des résultats.',
    'common.loading': 'Chargement',
    'common.error': "Une erreur s'est produite",
    'common.retry': 'Réessayer',
    'common.production': 'Production',
    'common.never': 'Jamais',
    'runs.title': 'Exécutions',
    'runs.empty.title': 'Aucune exécution',
    'runs.empty.body':
      'Ajoutez le reporter à votre workflow et envoyez un rapport pour voir les exécutions ici.',
    'runs.noCommitMessage': 'Pas de message de commit',
    'run.title': 'Exécution',
    'run.total': 'au total',
    'run.failureClusters': 'Échecs, regroupés par cause',
    'run.noFailures.title': 'Aucun échec',
    'run.noFailures.body': 'Tous les tests de cette exécution ont réussi ou ont été ignorés.',
    'run.allTests': 'Tous les tests',
    'cluster.failure': 'échec',
    'cluster.failures': 'échecs',
    'cluster.test': 'test',
    'cluster.tests': 'tests',
    'result.history': 'Historique récent',
    'result.error': 'Erreur',
    'result.screenshot': "Capture d'écran",
    'result.artifacts': 'Artefacts',
    'result.retry': 'tentative',
    'status.passed': 'réussis',
    'status.failed': 'échoués',
    'status.flaky': 'instables',
    'status.skipped': 'ignorés',
    'common.close': 'Fermer',
    'live.running': 'En cours',
    'live.reconnecting': 'Reconnexion…',
    'live.eta': 'environ',
    'live.cancel': 'Annuler',
    'live.cancelHint':
      "Marque l'exécution comme annulée et demande au reporter de s'arrêter. Arrêter le job GitHub Actions nécessite la GitHub App.",
    'live.lanes': 'Configurations',
    'live.failuresSoFar': 'Échecs jusqu\u2019ici',
    'live.recent': 'Résultats récents',
    'live.waiting': 'En attente des premiers résultats…',
  },
} as const satisfies Record<UiLocale, Record<string, string>>;

export type MessageKey = keyof (typeof dictionaries)['en'];

export const LocaleContext = createContext<UiLocale>('en');

export function useTranslate(): (key: MessageKey) => string {
  const locale = useContext(LocaleContext);
  return (key) => dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
}

export function useLocale(): UiLocale {
  return useContext(LocaleContext);
}
