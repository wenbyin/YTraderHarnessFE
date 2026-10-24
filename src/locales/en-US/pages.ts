export default {
  // ---- Casdoor single sign-on (backend contract app/services/user/user.yaml) ----
  'pages.login.casdoor.title': 'Sign in with your organization account',
  'pages.login.casdoor.subTitle':
    'Sign-in is handled by Y-Trader identity (Casdoor). Your password never reaches this app.',
  'pages.login.casdoor.submit': 'Continue to Casdoor',
  'pages.login.casdoor.hint':
    'If it reports that the backend could not reach Casdoor, or the authorization is rejected, these two server-side settings are usually the cause:',
  'pages.login.casdoor.hint2':
    'The same address must also be listed under Redirect URLs for the application in the Casdoor console.',
  'pages.login.casdoor.note':
    'This system keeps no accounts of its own — accounts, groups and permissions all live in Casdoor.',
  'pages.login.callback.title': 'Signing you in',
  'pages.login.callback.failed': 'Sign-in did not complete',
  'pages.login.callback.retry': 'Back to sign-in',
  'pages.login.callback.hint':
    'If the state check failed: sign-in has to be completed by the same browser in one go, and the redirect_uri must be registered in Casdoor.',
  'pages.404.subTitle': 'Sorry, the page you visited does not exist.',
  'pages.404.buttonText': 'Back Home',
};
