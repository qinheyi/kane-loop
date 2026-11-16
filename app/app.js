// SplitBill: split a bill (with tip) between people.
function money(n) {
  return "$" + n.toFixed(2);
}

function splitBill(bill, tipPercent, people) {
  const tip = bill * (tipPercent / 100);
  const total = bill + tip;
  const perPerson = total / people;
  return { tip, total, perPerson };
}

document.getElementById("split-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const bill = parseFloat(document.getElementById("bill").value);
  const tipPercent = parseFloat(document.getElementById("tip").value);
  const people = parseInt(document.getElementById("people").value, 10);
  const error = document.getElementById("error");
  const result = document.getElementById("result");

  if (!(bill > 0) || !(tipPercent >= 0) || !(people >= 1)) {
    error.textContent = "Please enter a bill above 0, a tip of 0 or more, and at least 1 person.";
    error.hidden = false;
    result.hidden = true;
    return;
  }

  const { tip, total, perPerson } = splitBill(bill, tipPercent, people);
  document.getElementById("tip-amount").textContent = money(tip);
  document.getElementById("total").textContent = money(total);
  document.getElementById("per-person").textContent = money(perPerson);
  error.hidden = true;
  result.hidden = false;
});
