const bcrypt = require('bcrypt');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; // raw password
const ADMIN_PASSHASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

module.exports = {
    // httpAdminRoot: "/",
    adminAuth: {
        type: "credentials",
        users: [{
            username: ADMIN_USERNAME,
            password: ADMIN_PASSHASH,
            permissions: ["*"]
        }]
    },

    logging: {
        console: {
            level: "debug"
        }
    },
    
    //  httpNodeAuth: {user: ADMIN_USERNAME, pass: ADMIN_PASSHASH},
    //  httpStaticAuth: {user: ADMIN_USERNAME, pass: ADMIN_PASSHASH},
    editorTheme: {
        tours: false,
    }
}