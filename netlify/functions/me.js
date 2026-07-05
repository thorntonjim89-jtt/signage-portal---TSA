const { getUserFromEvent, json } = require('./utils/auth');

exports.handler = async (event) => {
  const user = getUserFromEvent(event);
  if (!user) {
    return json(401, { error: 'Not authenticated' });
  }
  return json(200, { user });
};
