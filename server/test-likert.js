import axios from 'axios';

const submitUrl = "https://forms.office.com/formapi/api/9188040d-6c67-4c5b-b112-36a304b66dad/users/00000000-0000-0000-0006-bffd0be615c1/forms('DQSIkWdsW0yxEjajBLZtrQAAAAAAAAAAAAa__QvmFcFUQkFXOTRYTkxDSTdWMFFLQ0dQSE45MzFOSy4u')/responses";

async function test(answers) {
  const payload = {
    startDate: new Date().toISOString(),
    submitDate: new Date().toISOString(),
    answers: JSON.stringify(answers)
  };
  try {
    const res = await axios.post(submitUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    return { status: res.status, data: res.data };
  } catch (e) {
    return { status: e.response ? e.response.status : 0, data: e.response ? e.response.data : e.message };
  }
}

async function run() {
  console.log('Testing Variant 1: Semicolon list of answers with parent ID...');
  // Format: parentGroupId, answer1: "row1Key;row2Key", rowIndex: row1Index;row2Index
  const r1 = await test([
    { questionId: 'r15eafdc522fb4c298ea1ed7dfc2537e0', answer1: 'Sí' },
    { questionId: 'r5876bd98fe184711af5d0e9744da12cc', answer1: 'Bastante bien', rowIndex: 0 },
    { questionId: 'r5876bd98fe184711af5d0e9744da12cc', answer1: 'Bastante bien', rowIndex: 1 }
  ]);
  console.log('Result 1:', r1);

  console.log('\nTesting Variant 2: Stringified JSON of row answers inside answer1 of parent question...');
  // Format: parentGroupId, answer1: JSON.stringify({ "row1Id": "choiceValue", ... })
  const r2 = await test([
    { questionId: 'r15eafdc522fb4c298ea1ed7dfc2537e0', answer1: 'Sí' },
    {
      questionId: 'r5876bd98fe184711af5d0e9744da12cc',
      answer1: JSON.stringify({
        "r9a4cc0f8818241ba96350f510cf42383": "Bastante bien"
      })
    }
  ]);
  console.log('Result 2:', r2);

  console.log('\nTesting Variant 3: Stringified JSON of row answers with choice UUIDs...');
  const r3 = await test([
    { questionId: 'r15eafdc522fb4c298ea1ed7dfc2537e0', answer1: 'Sí' },
    {
      questionId: 'r5876bd98fe184711af5d0e9744da12cc',
      answer1: JSON.stringify({
        "r9a4cc0f8818241ba96350f510cf42383": "226fb74f-35c7-4c07-948f-12157101c4f7"
      })
    }
  ]);
  console.log('Result 3:', r3);
}

run();
