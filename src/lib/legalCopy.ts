/**
 * R40 P-04 — the Privacy and Terms texts, in one place. The in-app
 * pages (components/LegalPage) render exactly these words, and the
 * same words are kept as plain files for the owner. Written from the
 * app's real data flows: Firebase sign-in, projects and uploads in
 * the user's Firebase storage/database, editing on the device,
 * captions only on request, marketing email only by opt-in.
 */

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export const PRIVACY_TITLE = 'Privacy';

export const PRIVACY_INTRO =
  'This page says what RiddimRoom Studio collects, why, and the choices you have. It is written in plain words on purpose. If anything here is unclear, email us and we will explain it.';

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: 'Your account',
    paragraphs: [
      'When you sign up, we get your email address and the name you sign up with. Sign-in is handled by Firebase, the sign-in service from Google that this app uses. We never see your password.',
      'The owner can see the list of signups — names, emails, and whether access is switched on — so accounts can be switched on and looked after.',
    ],
  },
  {
    heading: 'Your projects and your files',
    paragraphs: [
      'Your projects are saved in the app\u2019s Firebase database, tied to your account. The videos, photos and audio you upload are saved in the app\u2019s Firebase file storage, also tied to your account.',
      'Your projects and files are yours. We do not look at them except to fix a problem you ask us about.',
    ],
  },
  {
    heading: 'Editing happens on your device',
    paragraphs: [
      'Editing and exporting happen on your phone or computer, inside the app. Your clips are not sent anywhere to be edited, and finished videos are made on your device.',
    ],
  },
  {
    heading: 'Captions, only when you ask',
    paragraphs: [
      'If you ask the app to write captions for a clip, the sound from that clip is sent to the caption service so it can be turned into words. That only happens when you tap to transcribe. Nothing is sent for captions at any other time.',
    ],
  },
  {
    heading: 'Marketing emails, only if you say yes',
    paragraphs: [
      'At signup you can choose whether to get RiddimRoom news, drops and offers by email. It is off unless you switch it on. If you say yes, we keep that choice with your account and we honour it — you will only get those emails if you said yes. You can ask us to stop at any time by email.',
    ],
  },
  {
    heading: 'Counts that help us fix problems',
    paragraphs: [
      'The app records counts of things that go wrong — for example, how many exports, saves or caption jobs failed. Counts only: never your words, your clips, or anything inside your projects. These counts help us find and fix problems.',
    ],
  },
  {
    heading: 'We never sell your information',
    paragraphs: [
      'We never sell your personal information, your email address, or anything about your projects to anyone.',
    ],
  },
  {
    heading: 'Your choices',
    paragraphs: [
      'You can ask us what we hold about you, ask us to correct it, or ask us to delete your account and the projects and files tied to it. Email us and we will sort it out. You can also use Delete my account on your home screen in the app — that sends the owner your request, and the owner completes it by hand.',
    ],
  },
];

export const TERMS_TITLE = 'Terms';

export const TERMS_INTRO =
  'These are the plain rules for using RiddimRoom Studio. By using the app you agree to them. If anything here is unclear, email us and we will explain it.';

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: 'What Studio is',
    paragraphs: [
      'RiddimRoom Studio is a video editor that runs in your browser. You use it to make short videos and posters from your own clips, photos, flyers and words, and to export them ready to post.',
    ],
  },
  {
    heading: 'Access to the app',
    paragraphs: [
      'New accounts are switched on by the owner, one by one. Until your account is switched on, you will see a waiting screen. The owner can switch an account off again if these rules are broken.',
      'You are responsible for your account and for keeping your sign-in details safe.',
    ],
  },
  {
    heading: 'Plans',
    paragraphs: [
      'The Free plan lets you make projects up to 30 seconds, with a small number of exports and caption jobs each day, and exports carry a small \u2018Made with RiddimRoom Studio\u2019 note.',
      'Lifetime lifts those limits: projects up to 10 minutes, more caption jobs each day, unlimited exports, and no note on exports.',
      'Lifetime is switched on by the owner for now. To get it, email us and the owner will switch it on for your account.',
    ],
  },
  {
    heading: 'Your content',
    paragraphs: [
      'Your clips, photos, flyers, words and finished videos stay yours. You give the app only the use it needs to store them, show them back to you, and make your exports on your device.',
      'Only upload things you have the right to use. Do not upload anything that breaks the law or someone else\u2019s rights.',
    ],
  },
  {
    heading: 'Fair use',
    paragraphs: [
      'Do not misuse the app — for example, do not try to get into other people\u2019s accounts or projects, and do not try to break or overload the service.',
    ],
  },
  {
    heading: 'The service as it is',
    paragraphs: [
      'We work to keep Studio running well, but it is provided as it is, without promises that it will never have a fault. Save copies of anything you cannot afford to lose. The app and these rules may change over time; big changes will be shown in the app.',
    ],
  },
  {
    heading: 'Talk to us',
    paragraphs: [
      'Questions about these rules, your account, or anything else — email us and we will help.',
    ],
  },
];
