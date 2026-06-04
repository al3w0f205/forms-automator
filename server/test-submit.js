import axios from 'axios';
import {
  resolveMicrosoftUrl,
  analyzeMicrosoftForm,
  submitMicrosoftForm
} from './microsoftForms.js';

async function run() {
  const url = 'https://forms.office.com/r/zrN0RhXP11';
  console.log('1. Analyzing form...');
  const analyzed = await analyzeMicrosoftForm(url);
  console.log('Analyzed Title:', analyzed.title);
  console.log('Questions count:', analyzed.questionCount);
  console.log('Submit URL:', analyzed.submitUrl);
  console.log('First Question:', JSON.stringify(analyzed.questions[0], null, 2));

  // Let's generate a mock answer and try to submit!
  // The first question is rating/scale (En general, ¿cuál es tu grado de satisfacción con este evento?)
  // Let's create a dummy generateAnswerFn
  const generateAnswerFn = (q) => {
    if (q.type === 'scale') return '5';
    if (q.type === 'radio') return 'Sí';
    if (q.type === 'checkbox') return ['Sí'];
    return 'Test response';
  };

  console.log('\n2. Submitting response...');
  const result = await submitMicrosoftForm(
    analyzed.submitUrl,
    analyzed.questions,
    generateAnswerFn,
    analyzed._msFormData
  );

  console.log('Submission result:', result);
}

run().catch(console.error);
