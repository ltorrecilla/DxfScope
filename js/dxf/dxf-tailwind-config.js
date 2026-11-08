// Shared DXF utility theme; load after Tailwind and before the app stylesheets.
tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            colors: {
                accent: {
                    DEFAULT: '#2563eb',
                    hover: '#1d4ed8',
                    light: '#dbeafe',
                    lighthov: '#bfdbfe',
                    lighter: '#eff6ff',
                },
            },
        },
    },
};
