// controllers/adminSubscriptionController.js

const Service = require("../services/adminSubscriptionViewService");

function noStore(res) {
  res.set("Cache-Control", "no-store, private");
}

exports.getSubscriptions = async (req, res, next) => {
  noStore(res);

  try {
    return res.render("admin/subscriptions/index", {
      layout: "layouts/app-layout",
      title: "Employer Subscriptions",
      breadcrumbs: [
        { label: "Home", url: "/admin/dashboard" },
        { label: "Employer Subscriptions", url: null },
      ],
      subscriptionView: await Service.list(req.query),
    });
  } catch (error) {
    return next(error);
  }
};

exports.getSubscription = async (req, res, next) => {
  noStore(res);

  try {
    const view = await Service.details(
      req.params.subscriptionId,
      req.query
    );

    return res.render("admin/subscriptions/show", {
      layout: "layouts/app-layout",
      title: "Subscription Details",
      breadcrumbs: [
        { label: "Home", url: "/admin/dashboard" },
        { label: "Employer Subscriptions", url: "/admin/subscriptions" },
        { label: view.subscription.reference, url: null },
      ],
      subscriptionView: view,
    });
  } catch (error) {
    return next(error);
  }
};
