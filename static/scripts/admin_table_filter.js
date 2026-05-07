document.querySelectorAll("[data-table-filter]").forEach((input) => {
    const table = document.querySelector(input.dataset.tableFilter);

    if (!table) {
        return;
    }

    const rows = Array.from(table.querySelectorAll("tbody tr"));

    input.addEventListener("input", () => {
        const query = input.value.trim().toLowerCase();

        rows.forEach((row) => {
            row.hidden = query && !row.textContent.toLowerCase().includes(query);
        });
    });
});
